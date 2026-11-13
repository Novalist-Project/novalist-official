using Microsoft.AspNetCore.SignalR.Client;

namespace Novalist.Sync.Client;

// BytesSinceBoundary includes the checkpoint that starts the history. CheckpointBytes and LastCompactedAt stay
// null until the project's first compaction or rotation.
public sealed record HostedProjectHistory(long HistoryStartsAt, long LastServerSeq, long BytesSinceBoundary,
    long? CheckpointBytes, DateTimeOffset? LastCompactedAt);

public sealed partial class HostedTransport
{
    public event Action<Guid, long>? HistoryCompacted;

    public Task<HostedProjectHistory> GetProjectHistoryAsync(Guid project, CancellationToken ct) =>
        hub.InvokeAsync<HostedProjectHistory>("GetProjectHistory", project, ct);
    public Task<HostedProjectEpoch> ReserveProjectCompactionAsync(Guid project, Guid compaction, CancellationToken ct) =>
        hub.InvokeAsync<HostedProjectEpoch>("ReserveProjectCompaction", project, compaction, ct);
    public Task<long> StageProjectCompactionAsync(Guid compaction, UpdateEnvelope envelope, CancellationToken ct) =>
        hub.InvokeAsync<long>("StageProjectCompaction", compaction, envelope, ct);
    public Task CommitProjectCompactionAsync(Guid compaction, CancellationToken ct) => hub.InvokeAsync("CommitProjectCompaction", compaction, ct);
    public Task CancelProjectCompactionAsync(Guid compaction, CancellationToken ct) => hub.InvokeAsync("CancelProjectCompaction", compaction, ct);
}
