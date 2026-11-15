#if NOVALIST_COLLABORATION
using Microsoft.AspNetCore.SignalR;
using Novalist.Sync.Client;

namespace Novalist.Backend;

internal sealed partial class HostedProjectWorkspace
{
    // Settable so tests can drive the loop without waiting a quarter of an hour.
    internal TimeSpan CompactionCheckInterval { get; set; } = TimeSpan.FromMinutes(15);
    internal TimeSpan CompactionCheckJitter { get; set; } = TimeSpan.FromMinutes(5);
    internal Func<HostedProjectHistory, DateTimeOffset, bool> CompactionDue { get; set; } = CompactionPolicy.IsDue;

    private void StartCompactionChecks(Runtime runtime) => runtime.CompactionChecks = Task.Run(async () =>
    {
        var token = runtime.Stopping.Token;
        while (!token.IsCancellationRequested)
        {
            try
            {
                // Jitter spreads writers out so two of them rarely reserve the project at the same moment.
                await Task.Delay(CompactionCheckInterval + CompactionCheckJitter * Random.Shared.NextDouble(), token);
                await CompactIfDueAsync(runtime, token);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { return; }
        }
    });

    internal Task<bool> CompactIfDueAsync(CancellationToken ct) =>
        current is { } runtime ? CompactIfDueAsync(runtime, ct) : Task.FromResult(false);

    private async Task<bool> CompactIfDueAsync(Runtime runtime, CancellationToken ct)
    {
        if (runtime.CompactionUnsupported || current != runtime || runtime.Session.Status.State != SessionConnectionState.Connected ||
            runtime.Session.Updates.HasPendingUpdates) return false;
        HostedProjectHistory history;
        try { history = await runtime.Session.Transport.GetProjectHistoryAsync(runtime.Access.ProjectId, ct); }
        catch (HubException)
        {
            // Servers before contracts 1.11 do not know the method; compaction stays off for this session.
            runtime.CompactionUnsupported = true;
            Extensions.Log.Info("Persistent compaction unavailable on this server.");
            return false;
        }
        if (!CompactionDue(history, DateTimeOffset.UtcNow)) return false;
        try
        {
            var latest = await CompactAsync(runtime, ct);
            runtime.Checkpoint = latest.Reference;
            runtime.CheckpointStart = latest.FirstServerSequence;
            await RememberAsync(runtime, workspace.Projects.ProjectRoot ?? throw new InvalidOperationException("The shared project closed."), ct);
            Extensions.Log.Info($"Persistent history compacted bytes={history.BytesSinceBoundary} checkpoint={history.CheckpointBytes?.ToString() ?? "none"}.");
            return true;
        }
        catch (Exception error) when (error is HubException or InvalidOperationException or InvalidDataException or IOException or AggregateException)
        {
            // Another writer won the reservation, the log moved on, or the upload failed: the next check retries.
            Extensions.Log.Warn($"Persistent compaction skipped type={error.GetType().Name}.");
            return false;
        }
    }

    private async Task<LatestCheckpoint> CompactAsync(Runtime runtime, CancellationToken ct)
    {
        await workspace.FlushSharedProjectFilesAsync();
        await runtime.Session.Updates.SynchronizeAsync(false, ct);
        var directory = Path.Combine(storage, "compactions", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            return await new HostedProjectCompaction(storage, runtime.Device, runtime.Session.Transport).CompactAsync(runtime.Access, async (boundary, token) =>
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
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    // A compaction by another writer arrives as an ordinary pointer update; invitations must start from it.
    private static void AdoptLatestCheckpoint(Runtime runtime)
    {
        if (CheckpointPointer.Read(runtime.Session.Updates) is not { } latest ||
            latest.FirstServerSequence <= (runtime.CheckpointStart ?? runtime.Access.FirstServerSequence)) return;
        runtime.Checkpoint = latest.Reference;
        runtime.CheckpointStart = latest.FirstServerSequence;
    }
}
#endif
