namespace Novalist.Sync.Client;

// Replaces the server's history with a checkpoint at the current epoch, so keys and invitations stay valid.
public sealed class HostedProjectCompaction(string storage, DeviceIdentity device, HostedTransport transport)
{
    public async Task<LatestCheckpoint> CompactAsync(HostedProjectAccess access,
        Func<long, CancellationToken, Task<Stream>> createCheckpoint, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(createCheckpoint);
        access.CheckTransport(transport);
        var compaction = Guid.NewGuid();
        try
        {
            var reserved = await transport.ReserveProjectCompactionAsync(access.ProjectId, compaction, ct);
            if (reserved.Epoch != access.Epoch || reserved.LastServerSeq < 0)
                throw new InvalidDataException("The project's encryption keys changed. Refresh them before compacting.");
            var firstServerSequence = checked(reserved.LastServerSeq + 1);
            CheckpointReference reference;
            await using (var checkpoint = await createCheckpoint(reserved.LastServerSeq, ct))
                reference = await StageAsync(access, compaction, firstServerSequence, checkpoint, ct);
            await transport.CommitProjectCompactionAsync(compaction, ct);
            return new(reference, firstServerSequence);
        }
        catch (Exception error)
        {
            await CancelFailedCompactionAsync(compaction, error);
            throw;
        }
    }

    private async Task CancelFailedCompactionAsync(Guid compaction, Exception failure)
    {
        using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        try { await transport.CancelProjectCompactionAsync(compaction, cleanup.Token); }
        catch (Exception cleanupFailure)
        {
            throw new AggregateException("Compaction failed and its reservation could not be cancelled. The reservation will expire automatically.",
                failure, cleanupFailure);
        }
    }

    private async Task<CheckpointReference> StageAsync(HostedProjectAccess access, Guid compaction, long firstServerSequence,
        Stream checkpoint, CancellationToken ct)
    {
        using var sequence = new DeviceSequence(Path.Combine(storage, "devices", device.Id.ToString("N") + ".sqlite"), device.Id);
        using var journal = new SessionJournal(Path.Combine(storage, "compactions", compaction.ToString("N"), "journal.sqlite"), compaction, access.ProjectId, sequence);
        using var cipher = access.CreateCipher();
        await using var staged = new StagedCheckpointTransport(transport, "compaction/" + compaction,
            (envelope, token) => transport.StageProjectCompactionAsync(compaction, envelope, token));
        await using var session = new CollaborationSession(new(access.ProjectId, device.Id, access.Epoch), journal, cipher, access.CreateSessionIdentity(device), staged);
        var reference = await CheckpointTransfer.PublishAsync(session, checkpoint, ct);
        CheckpointPointer.Save(session, new(reference, firstServerSequence));
        await session.SynchronizeAsync(createProject: false, ct);
        return reference;
    }
}

public static class CompactionPolicy
{
    public const long MinimumBytes = 1024 * 1024;
    // Until a project has a checkpoint of known size, compact once its log alone reaches this.
    public const long FirstCompactionBytes = 8 * 1024 * 1024;
    public static readonly TimeSpan MinimumInterval = TimeSpan.FromDays(1);

    // Compact when the history since the last checkpoint holds over four checkpoints' worth of bytes, at most daily.
    public static bool IsDue(HostedProjectHistory history, DateTimeOffset now)
    {
        if (history.BytesSinceBoundary < MinimumBytes) return false;
        if (history.LastCompactedAt is { } last && now - last < MinimumInterval) return false;
        return history.CheckpointBytes is { } checkpoint
            ? history.BytesSinceBoundary > checked(checkpoint * 4)
            : history.BytesSinceBoundary >= FirstCompactionBytes;
    }
}
