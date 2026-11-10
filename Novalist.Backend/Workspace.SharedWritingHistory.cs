#if NOVALIST_COLLABORATION
using System.Text.Json;
using System.Security.Cryptography;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Novalist.Sync.Client;

namespace Novalist.Backend;

public sealed partial class Workspace
{
    private sealed record SharedHistoryMarker(int Sequence, bool Undone);

    internal async Task<StructureCommit> RestoreWritingStructureAsync(string operationId, bool undo, SharedStructureInverse? inverse)
    {
        if (sharedProjectFiles is not { } files) return await new ManuscriptStructureService(Projects).RestoreAsync(operationId, undo);
        var original = JsonSerializer.Deserialize<SharedStructureReceipt>(await files.ReadStrictResultAsync("structure:" + operationId, CancellationToken.None)
            ?? throw new InvalidOperationException("The shared structure operation is missing.")) ?? throw new InvalidDataException("Invalid structure receipt.");
        if (Projects.ActiveBook is not { } book || book.Id != original.BookId || book.ActiveDraftId != original.DraftId)
            throw new InvalidOperationException("writing.workspaceChanged");
        var markerPath = Path.Combine(sharedRoot ?? throw new InvalidOperationException("The shared project is closed."), ".novalist", "writing-history", WritingOperationJournal.OperationId(operationId) + ".json");
        var marker = await FileService.ExistsAsync(markerPath) ? JsonSerializer.Deserialize<SharedHistoryMarker>(await FileService.ReadTextAsync(markerPath))
            ?? throw new InvalidDataException("Invalid shared history marker.") : new(0, false);
        if (marker.Undone == undo) return original.Commit with { FocusScene = undo ? null : original.Commit.FocusScene };
        var transaction = $"structure-history:{operationId}:{marker.Sequence + 1}";
        var fingerprint = WritingOperationJournal.OperationId(JsonSerializer.Serialize(new { operationId, undo, inverse }));
        var leases = new List<FieldLeaseRequest>();
        try
        {
        var receipt = await files.CommitStrictAsync(transaction, fingerprint, async (canonical, ct) =>
        {
            var updates = await PrepareSharedInverseAsync(original, inverse, ct);
            var changes = original.Changes.Select(change => undo ? new SharedFileChange(change.Path, change.After, change.Before) : change).ToList();
            var restored = RestoreWritingBindings(original, changes, inverse, undo);
            var metadata = original.MetadataUpdates.Select(update => undo ? new SharedMetadataUpdate(update.ItemId, update.After, update.Before) : update).ToArray();
            var batch = new SharedProjectCommit(changes, restored, JsonSerializer.Serialize(original.Commit with { FocusScene = undo ? null : original.Commit.FocusScene })) { DocumentUpdates = updates, MetadataUpdates = metadata };
            await ValidateWritingInverseAsync(original, undo, batch, leases, ct);
            return batch;
        }, CancellationToken.None, (retained, ct) => ValidateWritingInverseAsync(original, undo, retained, leases, ct));
        await FileService.WriteTextAsync(markerPath, JsonSerializer.Serialize(new SharedHistoryMarker(marker.Sequence + 1, undo)));
        return JsonSerializer.Deserialize<StructureCommit>(receipt) ?? throw new InvalidDataException("Invalid structure history result.");
        }
        finally { await ReleaseWritingMetadataAsync(leases); }
    }

    private async Task ValidateWritingInverseAsync(SharedStructureReceipt original, bool undo, SharedProjectCommit batch, List<FieldLeaseRequest> leases, CancellationToken ct)
    {
        if (undo) await ValidateNewWritingBindingsAsync(original, ct);
        await ValidateWritingCommitAsync(batch, leases, ct);
    }

    private async Task<SharedDocumentUpdate[]> PrepareSharedInverseAsync(SharedStructureReceipt original, SharedStructureInverse? inverse, CancellationToken ct)
    {
        if (original.Split is not { } split) return [];
        if (inverse is null || inverse.SessionId != sharedSession || inverse.ItemId != split.ItemId)
            throw new InvalidOperationException("The shared inverse needs a fresh collaborative update.");
        var scenes = RequireSharedScenes(sharedSession);
        var source = await scenes.ReadAsync(split.ItemId, ct);
        if (!source.State.AsSpan().SequenceEqual(inverse.SourceState)) throw new WritingConflictException("The shared source changed before the inverse.");
        await scenes.ValidateStructureAsync([new(split.ItemId, inverse.Update)], ct);
        return [new(split.ItemId, inverse.Update)];
    }

    private SharedProjectState RestoreWritingBindings(SharedStructureReceipt original, List<SharedFileChange> changes,
        SharedStructureInverse? inverse, bool undo)
    {
        var source = undo ? original.BeforeBindings : original.AfterBindings;
        var destinations = changes.Where(change => change.After is not null).Select(change => change.Path).ToHashSet(StringComparer.Ordinal);
        var hashes = changes.Where(change => change.After is not null).ToDictionary(change => change.Path,
            change => Convert.ToHexStringLower(SHA256.HashData(change.After ?? throw new InvalidDataException("Missing restored content."))));
        var documents = new List<SharedDocumentState>();
        foreach (var document in source.Documents.Where(document => destinations.Contains(document.Path)))
        {
            var binding = document;
            if (!undo && original.Split is { } split && document.ItemId == split.CreatedItemId)
            {
                if (inverse?.CreatedItemId is not { } created || created == Guid.Empty || inverse.CreatedState is not { Length: > 0 } state || sharedSceneFiles.ContainsKey(created))
                    throw new InvalidOperationException("Redo needs a new child collaboration binding.");
                binding = document with { ItemId = created, State = state };
            }
            else if (!undo && !original.BeforeBindings.Documents.Any(before => before.ItemId == document.ItemId)) binding = document with { ItemId = Guid.NewGuid() };
            documents.Add(binding with { SourceSha256 = hashes[binding.Path] });
        }
        var fields = source.Fields.Where(field => destinations.Contains(field.Path)).Select(field => !undo && !original.BeforeBindings.Fields.Any(before => before.ItemId == field.ItemId)
            ? field with { ItemId = Guid.NewGuid(), SourceSha256 = hashes[field.Path] } : field with { SourceSha256 = hashes[field.Path] }).ToArray();
        return new(documents, fields);
    }
}
#endif
