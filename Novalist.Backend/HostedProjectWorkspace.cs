#if NOVALIST_COLLABORATION
using Novalist.Sync.Client;

namespace Novalist.Backend;

internal sealed partial class HostedProjectWorkspace : IDisposable
{
    private readonly Workspace workspace;
    private readonly HostedAccounts accounts;
    private readonly DeviceIdentityStore devices;
    private readonly HostedProjectAccessStore accessStore;
    private readonly string storage;
    private readonly CancellationTokenSource stopping = new();
    private readonly object operationGate = new();
    private CancellationTokenSource? pending;
    private Runtime? current;
    internal bool IsActive => current is not null;
    internal bool OwnsJournal { get { lock (operationGate) return current is not null || pending is not null; } }
    internal HostedSessionDto? Status => current?.View();
    internal long? AdoptedCheckpointStart => current?.CheckpointStart;

    internal HostedProjectWorkspace(Workspace workspace, HostedAccounts accounts, ICollaborationCredentials credentials)
    {
        this.workspace = workspace;
        this.accounts = accounts;
        devices = new(credentials);
        accessStore = new(credentials);
        storage = Path.Combine(workspace.SettingsDirectory ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Novalist"), "Collaboration", "persistent");
    }

    internal async Task<HostedSessionDto> CreateAsync(Uri server, CancellationToken ct)
    {
        using var operation = BeginOperation(ct);
        ct = operation.Token;
        workspace.RequireNoSharedSession();
        var root = workspace.Projects.ProjectRoot ?? throw new InvalidOperationException("Open a project first.");
        var runtime = await PrepareAsync(server, null, ct);
        try
        {
            await using var archive = OpenArchive(runtime.Id);
            var state = await workspace.CaptureSharedProjectAsync(archive, ct);
            await archive.FlushAsync(ct);
            archive.Flush(true);
            archive.Position = 0;
            await runtime.Session.StartAsync(true, ct);
            runtime.Checkpoint = await CheckpointTransfer.PublishAsync(runtime.Session.Updates, archive, ct);
            archive.Position = 0;
            await workspace.AttachSharedProjectAsync(runtime.Id, runtime.Session.Updates, state, archive, ct);
            await RememberAsync(runtime, root, ct);
        }
        catch
        {
            await workspace.DetachSharedScenesAsync();
            await runtime.DisposeAsync();
            throw;
        }
        current = runtime;
        StartCompactionChecks(runtime);
        return runtime.View();
    }

    internal async Task<HostedSessionDto> JoinAsync(Uri server, string link, string destination, CancellationToken ct)
    {
        using var operation = BeginOperation(ct);
        ct = operation.Token;
        workspace.RequireNoSharedSession();
        destination = Path.GetFullPath(destination);
        if (Directory.Exists(destination) || File.Exists(destination)) throw new IOException("Choose a new folder for the shared project.");
        var runtime = await PrepareAsync(server, link, ct);
        var previousRoot = workspace.Projects.ProjectRoot;
        var installed = false;
        try
        {
            await runtime.Session.ConnectAsync(ct);
            await runtime.Session.StartAsync(false, ct);
            // A pointer in the caught-up log names a checkpoint newer than the invitation's, written by a compaction.
            runtime.Checkpoint = CheckpointPointer.Read(runtime.Session.Updates)?.Reference
                ?? runtime.Access.Checkpoint ?? throw new InvalidDataException("The invitation has no project checkpoint.");
            await using var archive = OpenArchive(runtime.Id);
            await workspace.ReportCollaborationProgressAsync(new("transferring", 0, 0, 0, 0));
            await CheckpointTransfer.DownloadAsync(runtime.Session.Updates, runtime.Checkpoint, archive, RetainedProjectCopies.FreeSpace(destination), ct);
            await archive.FlushAsync(ct);
            archive.Flush(true);
            archive.Position = 0;
            var state = await ProjectCheckpoint.InstallAsync(archive, destination, RetainedProjectCopies.FreeSpace(destination), ct);
            installed = true;
            await workspace.OpenProjectAsync(destination);
            archive.Position = 0;
            await workspace.AttachSharedProjectAsync(runtime.Id, runtime.Session.Updates, state, archive, ct);
            await RememberAsync(runtime, destination, ct);
            await workspace.ReportCollaborationProgressAsync(new("complete", 0, 0, 0, 0));
        }
        catch
        {
            try
            {
                await workspace.DetachSharedScenesAsync();
                if (installed)
                {
                    if (previousRoot is not null) await workspace.OpenProjectAsync(previousRoot);
                    else await workspace.CloseProjectAsync();
                    Directory.Delete(destination, recursive: true);
                }
            }
            finally { await runtime.DisposeAsync(); }
            throw;
        }
        current = runtime;
        StartCompactionChecks(runtime);
        return runtime.View();
    }

    internal async Task<string> InviteAsync(DateTimeOffset expiresAt, CancellationToken ct)
    {
        var runtime = RequireOwner();
        AdoptLatestCheckpoint(runtime);
        return await HostedProjectInvitations.CreateAsync(runtime.Access, runtime.Device, runtime.Session.Transport,
            new(runtime.Checkpoint ?? throw new InvalidOperationException("Publish the project before inviting someone."), expiresAt,
                runtime.CheckpointStart), ct);
    }

    private async Task<Runtime> PrepareAsync(Uri server, string? link, CancellationToken ct)
    {
        var account = await accounts.RestoreAsync(server, ct) ?? throw new InvalidOperationException("Sign in to the persistent server first.");
        var device = await devices.GetOrCreateAsync(account.Authority, account.DeviceSubject, ct);
        HostedProjectAccess? access = null;
        try
        {
            access = link is null ? await accessStore.CreateOwnerAsync(server, device, ct) : await accessStore.PrepareJoinAsync(link, device, ct);
            if (access.Server != new Uri(server.AbsoluteUri.TrimEnd('/') + '/'))
                throw new InvalidOperationException("Connect to the server named by this invitation.");
            if (link is not null)
            {
                await using var transport = new HostedTransport(access.Server, device, () => account.GetAccessTokenAsync(stopping.Token));
                await transport.ConnectAsync(ct);
                await accessStore.ActivateAsync(access, transport, ct);
                // An invitation made before a compaction names a start the server no longer serves.
                if (await ReadHistoryAsync(transport, access.ProjectId, ct) is { } history && history.HistoryStartsAt > access.FirstServerSequence)
                {
                    var moved = access.StartingAt(history.HistoryStartsAt, device);
                    access.Dispose();
                    access = moved;
                }
            }
            var id = Guid.NewGuid();
            var session = await HostedProjectSession.OpenAsync(storage, id, access, device, () => account.GetAccessTokenAsync(stopping.Token));
            return new(id, device, access, session, account.DisplayName);
        }
        catch { access?.Dispose(); device.Dispose(); throw; }
    }

    internal async Task ReleaseAsync()
    {
        if (current is not { } runtime) return;
        await runtime.DisposeAsync();
        current = null;
    }

    internal async Task FlushAsync()
    {
        if (current is not { } runtime || !runtime.Session.Transport.IsConnected) return;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        try { await runtime.Session.Updates.SynchronizeAsync(false, timeout.Token); }
        catch (Exception error) when (error is HttpRequestException or IOException or TimeoutException or OperationCanceledException
            or Microsoft.AspNetCore.SignalR.HubException or UnauthorizedAccessException)
        {
            Extensions.Log.Warn($"Persistent disconnect retained pending updates type={error.GetType().Name}.");
            if (workspace.Coordinator?.Notify is { } notify)
            {
                try { await notify("ui/showNotification", "Disconnected with pending changes. Your writing is saved locally and will synchronize when you reconnect."); }
                catch (Exception notificationError) when (notificationError is not OutOfMemoryException)
                { Extensions.Log.Warn($"Persistent disconnect notification failed type={notificationError.GetType().Name}."); }
            }
        }
    }

    internal Task PublishPresenceAsync(Guid sessionId, Guid itemId, Guid viewId, CursorSelection? selection, bool active, CancellationToken ct)
    {
        var runtime = RequireSession(sessionId);
        return runtime.Session.Presence.PublishAsync(new(itemId, viewId, runtime.Name, selection, active), ct);
    }

    internal IReadOnlyList<ParticipantPresence> Participants(Guid sessionId) => RequireSession(sessionId).Session.Presence.Snapshot();
    private Runtime RequireSession(Guid sessionId) => current is { } runtime && runtime.Id == sessionId
        ? runtime : throw new InvalidOperationException("This collaboration session is no longer active.");

    private FileStream OpenArchive(Guid id)
    {
        var directory = Path.Combine(storage, "sessions", id.ToString("N"));
        Directory.CreateDirectory(directory);
        return new(Path.Combine(directory, "checkpoint.zip"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read);
    }

    private Operation BeginOperation(CancellationToken ct)
    {
        lock (operationGate)
        {
            if (pending is not null) throw new InvalidOperationException("A collaboration connection is already being prepared.");
            pending = CancellationTokenSource.CreateLinkedTokenSource(ct, stopping.Token);
            return new(this, pending);
        }
    }

    private sealed class Operation(HostedProjectWorkspace owner, CancellationTokenSource source) : IDisposable
    {
        internal CancellationToken Token => source.Token;
        public void Dispose()
        {
            lock (owner.operationGate) { owner.pending = null; source.Dispose(); }
        }
    }

    internal void Cancel() { lock (operationGate) pending?.Cancel(); }
    internal void StopPendingOperations() { stopping.Cancel(); Cancel(); }
    public void Dispose() => stopping.Dispose();

    private sealed class Runtime(Guid id, DeviceIdentity device, HostedProjectAccess access, HostedProjectSession session, string name) : IAsyncDisposable
    {
        internal Guid Id => id;
        internal DeviceIdentity Device => device;
        internal HostedProjectAccess Access => access;
        internal HostedProjectSession Session => session;
        internal string Name => name;
        internal CheckpointReference? Checkpoint { get; set; }
        // Where the server history starts at Checkpoint when a compaction moved it past this session's own start.
        internal long? CheckpointStart { get; set; }
        internal bool CompactionUnsupported { get; set; }
        internal CancellationTokenSource Stopping { get; } = new();
        internal Task CompactionChecks { get; set; } = Task.CompletedTask;
        internal string? RecoveryPath { get; set; }
        internal IReadOnlyList<PendingSessionUpdate> PendingUpdates { get; init; } = [];
        internal HostedSessionDto View() => new(id, access.ProjectId, access.Server.AbsoluteUri, session.Status.State.ToString(), access.IsOwner, RecoveryPath, "persistent",
            session.Updates.HasPendingUpdates);
        public async ValueTask DisposeAsync()
        {
            await Stopping.CancelAsync();
            await CompactionChecks;
            Stopping.Dispose();
            await session.DisposeAsync();
            access.Dispose();
            device.Dispose();
        }
    }
}
#endif
