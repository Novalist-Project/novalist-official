#if NOVALIST_COLLABORATION
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Novalist.Sync.Client;

namespace Novalist.Backend;

internal sealed partial class HostedProjectWorkspace
{
    private sealed record SavedProject(int Version, Guid SessionId, Guid ProjectId, Uri Server, Guid DeviceId,
        string Root, string LocalProjectId, CheckpointReference Checkpoint, string? RecoveryPath, uint Epoch);

    internal async Task<SavedHostedProjectDto?> SavedAsync()
    {
        var saved = await FindSavedAsync();
        return saved is null ? null : new(saved.Server.AbsoluteUri, saved.ProjectId, saved.RecoveryPath, "persistent", File.GetLastWriteTimeUtc(RegistryPath(saved.Root)));
    }

    private async Task<SavedProject?> FindSavedAsync()
    {
        if (workspace.Projects.ProjectRoot is not { } root) return null;
        var path = RegistryPath(root);
        if (!File.Exists(path)) return null;
        var saved = JsonSerializer.Deserialize<SavedProject>(await File.ReadAllTextAsync(path))
            ?? throw new InvalidDataException("Invalid saved collaboration context.");
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        if (saved.Version != 1 || saved.SessionId == Guid.Empty || saved.ProjectId == Guid.Empty || saved.DeviceId == Guid.Empty ||
            !Path.GetFullPath(saved.Root).Equals(Path.GetFullPath(root), comparison) || saved.LocalProjectId != ReadProjectId(root))
            throw new InvalidDataException("The saved collaboration context belongs to a different local project.");
        return saved;
    }

    private string RegistryPath(string root)
    {
        var canonical = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        if (OperatingSystem.IsWindows()) canonical = canonical.ToUpperInvariant();
        return Path.Combine(storage, "projects", Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))) + ".json");
    }

    private Task RememberAsync(Runtime runtime, string root, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var saved = new SavedProject(1, runtime.Id, runtime.Access.ProjectId, runtime.Access.Server, runtime.Device.Id,
            root, ReadProjectId(root), runtime.Checkpoint ?? throw new InvalidOperationException("The checkpoint is missing."),
            runtime.RecoveryPath, runtime.Access.Epoch);
        return workspace.FileService.WriteTextAsync(RegistryPath(root), JsonSerializer.Serialize(saved));
    }

    private static string ReadProjectId(string root)
    {
        using var project = JsonDocument.Parse(File.ReadAllBytes(SharedProjectPath.Resolve(root, ".novalist/project.json")));
        return project.RootElement.GetProperty("id").GetString() ?? throw new InvalidDataException("The project identity is missing.");
    }

    internal async Task<HostedSessionDto> ResumeAsync(CancellationToken ct)
    {
        using var operation = BeginOperation(ct);
        ct = operation.Token;
        workspace.RequireNoSharedSession();
        var saved = await FindSavedAsync() ?? throw new InvalidOperationException("This local project has no saved persistent connection.");
        var runtime = await ReopenAsync(saved, ct);
        try
        {
            await runtime.Session.StartAsync(false, ct);
            var archivePath = Path.Combine(storage, "sessions", runtime.Id.ToString("N"), "checkpoint.zip");
            if (runtime.Access.Epoch != saved.Epoch)
            {
                await using var download = OpenArchive(runtime.Id);
                await CheckpointTransfer.DownloadAsync(runtime.Session.Updates,
                    runtime.Checkpoint ?? throw new InvalidDataException("The refreshed checkpoint is missing."), download,
                    RetainedProjectCopies.FreeSpace(saved.Root), ct);
                await download.FlushAsync(ct);
                download.Flush(true);
            }
            await using var archive = File.OpenRead(archivePath);
            using var restore = await RetainedProjectRestore.PrepareAsync(saved.Root, archive, storage, ct);
            runtime.RecoveryPath = restore.RecoveryPath;
            try
            {
                await restore.ApplyAsync(workspace.FileService, ct);
                await workspace.OpenProjectAsync(saved.Root);
                var documents = restore.State.Documents.Select(document => document.ItemId).ToHashSet();
                foreach (var pendingUpdate in runtime.PendingUpdates.Where(update => documents.Contains(update.ItemId)))
                    runtime.Session.Updates.Save(pendingUpdate.ItemId, pendingUpdate.Update);
                archive.Position = 0;
                await workspace.AttachSharedProjectAsync(runtime.Id, runtime.Session.Updates, restore.State, archive, ct);
                await RememberAsync(runtime, saved.Root, ct);
            }
            catch
            {
                await workspace.DetachSharedScenesAsync();
                await restore.RollbackAsync(workspace.FileService);
                await workspace.OpenProjectAsync(saved.Root);
                throw;
            }
        }
        catch { await runtime.DisposeAsync(); throw; }
        current = runtime;
        return runtime.View();
    }

    private async Task<Runtime> ReopenAsync(SavedProject saved, CancellationToken ct)
    {
        var account = await accounts.RestoreAsync(saved.Server, ct) ?? throw new InvalidOperationException("Sign in to the saved server first.");
        var device = await devices.GetOrCreateAsync(account.Authority, account.Subject, ct);
        HostedProjectAccess? access = null;
        HostedProjectSession? session = null;
        try
        {
            if (device.Id != saved.DeviceId) throw new InvalidOperationException("Sign in with the account that joined this local project.");
            access = await accessStore.LoadAsync(saved.Server, saved.ProjectId, device, ct)
                ?? throw new InvalidOperationException("This device no longer has the saved project credentials.");
            var pendingEdits = HostedProjectSession.ReadPendingCompoundEdits(storage, saved.SessionId, saved.ProjectId, device.Id);
            var pendingUpdates = HostedProjectSession.ReadPendingUpdates(storage, saved.SessionId, saved.ProjectId, device.Id);
            await using (var transport = new HostedTransport(saved.Server, device, () => account.GetAccessTokenAsync(stopping.Token)))
            {
                await transport.ConnectAsync(ct);
                if (await accessStore.RefreshEpochAsync(access, device, transport, ct) is { } next)
                { access.Dispose(); access = next; }
            }
            var id = access.Epoch == saved.Epoch ? saved.SessionId : Guid.NewGuid();
            session = await HostedProjectSession.OpenAsync(storage, id, access, device, () => account.GetAccessTokenAsync(stopping.Token));
            if (id != saved.SessionId) foreach (var edit in pendingEdits) session.Updates.SaveCompoundEdit(edit);
            return new(id, device, access, session, account.DisplayName)
            {
                Checkpoint = access.Epoch == saved.Epoch ? saved.Checkpoint : access.Checkpoint,
                PendingUpdates = access.Epoch == saved.Epoch ? [] : pendingUpdates
            };
        }
        catch
        {
            if (session is not null) await session.DisposeAsync();
            access?.Dispose();
            device.Dispose();
            throw;
        }
    }
}
#endif
