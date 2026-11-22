using System.Text.Json;
using System.Text.Json.Nodes;

namespace Novalist.Sync.Client;

public sealed record SharedProjectCommit(IReadOnlyList<SharedFileChange> Changes, SharedProjectState AddedState, string ResultJson)
{
    public IReadOnlyList<SharedDocumentUpdate> DocumentUpdates { get; init; } = [];
    public IReadOnlyList<SharedMetadataUpdate> MetadataUpdates { get; init; } = [];
}
public sealed class SharedProjectConflictException(string message) : IOException(message);

public sealed partial class SharedProjectFiles
{
    private sealed record Receipt(string Fingerprint, string ResultJson);
    private readonly Dictionary<string, Receipt> receipts = new(StringComparer.Ordinal);

    public async Task<string> CommitStrictAsync(string transactionId, string fingerprint,
        Func<IReadOnlyDictionary<string, byte[]>, CancellationToken, Task<SharedProjectCommit>> plan, CancellationToken ct,
        Func<SharedProjectCommit, CancellationToken, Task>? validateRetained = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(transactionId);
        ArgumentException.ThrowIfNullOrWhiteSpace(fingerprint);
        await editing.WaitAsync(ct);
        try
        {
            EnsureOpen();
            var request = await session.CreateFieldRequestAsync(ItemId, ct);
            var lease = await session.AcquireFieldAsync(request, ct);
            if (!lease.Acquired) throw new InvalidOperationException("Another collaborator is saving project changes. Retry shortly.");
            try
            {
                await RefreshAsync(ct);
                if (FindReceipt(transactionId, fingerprint) is { } previous) return previous;
                var current = await SnapshotAsync(ct);
                var retained = RetainedBatch(transactionId, fingerprint);
                FileBatch batch;
                if (retained is { } pending)
                {
                    batch = pending.Batch;
                    await StrictChangesAsync(batch.Changes, current, ct);
                    if (validateRetained is not null) await validateRetained(new(batch.Changes, batch.AddedState, batch.ResultJson ?? throw new InvalidDataException("Missing retained receipt."))
                        { DocumentUpdates = batch.DocumentUpdates ?? [], MetadataUpdates = batch.MetadataUpdates ?? [] }, ct);
                    session.RebindPendingField(ItemId, pending.Lease, request);
                }
                else
                {
                    var prepared = await plan(current, ct);
                    var filtered = await StrictChangesAsync(prepared.Changes, current, ct);
                    batch = new FileBatch(prepared.DocumentUpdates.Count + prepared.MetadataUpdates.Count == 0 ? 1 : 2, filtered, SharedProjectFileBindings.Copy(prepared.AddedState),
                        Interlocked.Read(ref projectedSequence), transactionId, fingerprint, prepared.ResultJson, prepared.DocumentUpdates, prepared.MetadataUpdates);
                }
                Validate(batch);
                await session.CommitFieldAsync(ItemId, JsonSerializer.SerializeToUtf8Bytes(batch), request, ct);
                await RefreshAsync(ct);
                return FindReceipt(transactionId, fingerprint) ?? throw new IOException("The shared writing operation has not been acknowledged.");
            }
            finally { await session.ReleaseFieldAsync(request, CancellationToken.None); }
        }
        finally { editing.Release(); }
    }

    private (FileBatch Batch, FieldLeaseRequest Lease)? RetainedBatch(string transactionId, string fingerprint)
    {
        foreach (var pending in session.PendingFieldUpdates(ItemId))
        {
            var batch = JsonSerializer.Deserialize<FileBatch>(pending.Payload) ?? throw new InvalidDataException("Invalid retained project batch.");
            if (batch.TransactionId != transactionId) continue;
            if (batch.Fingerprint != fingerprint) throw new InvalidOperationException("The retained writing transaction has different edits.");
            return (batch, pending.Lease);
        }
        return null;
    }

    private string? FindReceipt(string transactionId, string fingerprint)
    {
        if (!receipts.TryGetValue(transactionId, out var receipt)) return null;
        if (receipt.Fingerprint != fingerprint) throw new InvalidOperationException("The writing transaction identifier was already used for different edits.");
        return receipt.ResultJson;
    }

    public async Task<string?> ReadStrictResultAsync(string transactionId, CancellationToken ct)
    {
        await RefreshAsync(ct);
        return receipts.GetValueOrDefault(transactionId)?.ResultJson;
    }

    private static async Task<IReadOnlyList<SharedFileChange>> StrictChangesAsync(IReadOnlyList<SharedFileChange> changes,
        IReadOnlyDictionary<string, byte[]> current, CancellationToken ct)
    {
        var result = new List<SharedFileChange>();
        foreach (var change in changes)
        {
            var before = change.Before is null ? null : await FilterContentAsync(change.Path, change.Before, ct);
            var after = change.After is null ? null : await FilterContentAsync(change.Path, change.After, ct);
            var actual = current.GetValueOrDefault(change.Path);
            if (!Equivalent(change.Path, actual, before)) throw new SharedProjectConflictException("A shared writing file changed before commit.");
            result.Add(new(change.Path, actual, after));
        }
        return result;
    }

    private static bool Equivalent(string path, byte[]? actual, byte[]? expected)
        => SharedFileMerge.Equal(actual, expected) || actual is not null && expected is not null
            && path.EndsWith(".json", StringComparison.OrdinalIgnoreCase) && JsonNode.DeepEquals(JsonNode.Parse(actual), JsonNode.Parse(expected));
}
