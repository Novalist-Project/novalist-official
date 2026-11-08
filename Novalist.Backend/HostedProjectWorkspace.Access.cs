#if NOVALIST_COLLABORATION
using Novalist.Sync.Client;

namespace Novalist.Backend;

internal sealed partial class HostedProjectWorkspace
{
    internal Task<IReadOnlyList<HostedProjectMember>> MembersAsync(CancellationToken ct)
    {
        var runtime = RequireOwner();
        return runtime.Session.Transport.ListProjectMembersAsync(runtime.Access.ProjectId, ct);
    }

    internal async Task RemoveMemberAsync(Guid member, CancellationToken ct)
    {
        var runtime = RequireOwner();
        var account = await accounts.RestoreAsync(runtime.Access.Server, ct)
            ?? throw new InvalidOperationException("Sign in before changing shared access.");
        using var device = await devices.GetOrCreateAsync(account.Authority, account.Subject, ct);
        using var access = await accessStore.LoadAsync(runtime.Access.Server, runtime.Access.ProjectId, device, ct)
            ?? throw new InvalidOperationException("The saved project credentials are missing.");
        await workspace.FlushSharedProjectFilesAsync();
        await runtime.Session.Updates.SynchronizeAsync(false, ct);
        var directory = Path.Combine(storage, "rotations", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        await using var transport = new HostedTransport(access.Server, device, () => account.GetAccessTokenAsync(stopping.Token));
        await transport.ConnectAsync(ct);
        await new HostedProjectRotation(storage, device, transport).RotateAsync(access, member, async (boundary, token) =>
        {
            await runtime.Session.Updates.SynchronizeAsync(false, token);
            var archive = new FileStream(Path.Combine(directory, "checkpoint.zip"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read);
            try
            {
                await runtime.Session.Updates.CaptureSnapshotAsync(async (sequence, captureToken) =>
                {
                    if (sequence != boundary) throw new InvalidOperationException("The checkpoint does not match the reserved project history.");
                    await workspace.CaptureActiveSharedProjectAsync(archive, captureToken);
                    return true;
                }, token);
                await archive.FlushAsync(token);
                archive.Flush(true);
                archive.Position = 0;
                return archive;
            }
            catch { await archive.DisposeAsync(); throw; }
        }, ct);
        await runtime.Session.Updates.PauseAsync(ct);
        await workspace.DetachSharedScenesAsync();
        await ResumeAsync(ct);
    }

    internal async Task DeleteSharedProjectAsync(CancellationToken ct)
    {
        var runtime = RequireOwner();
        await runtime.Session.Transport.DeleteProjectAsync(runtime.Access.ProjectId, ct);
        await runtime.Session.Updates.PauseAsync(ct);
        await workspace.DetachSharedScenesAsync();
    }

    private Runtime RequireOwner()
    {
        var runtime = current ?? throw new InvalidOperationException("Open the shared project first.");
        if (!runtime.Access.IsOwner) throw new UnauthorizedAccessException("Only the project owner can manage shared access.");
        return runtime;
    }
}
#endif
