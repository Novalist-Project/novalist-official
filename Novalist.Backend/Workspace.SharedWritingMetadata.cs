#if NOVALIST_COLLABORATION
using System.Text.Json.Nodes;
using Novalist.Core.Services;
using Novalist.Sync.Client;

namespace Novalist.Backend;

public sealed partial class Workspace
{
    private async Task ProjectWritingMetadataAsync(string root, SharedFieldBinding binding, JsonObject entity, string previous, string next)
    {
        if (previous == next) return;
        var files = new StagedFileService(FileService);
        if (binding.Metadata?.Kind is "codex" or "override" or "section" or "state" or "image" or "attachment")
            await FieldHistory(root, binding, Projects.CreateStaged(files)).RecordAsync(
                entity["id"]?.GetValue<string>() ?? throw new InvalidDataException("The shared Codex identity is missing."), previous, next);
        await files.WriteTextAsync(SharedProjectPath.Resolve(root, binding.Path), next);
        var journal = new WritingOperationJournal(root, FileService);
        var operation = await journal.PrepareAsync($"shared-metadata:{projectingSharedSequence}:{binding.ItemId}", WritingOperationJournal.OperationId(next), files.Changes);
        await journal.CommitAsync(operation);
    }

    private async Task ValidateWritingCommitAsync(SharedProjectCommit retained, List<FieldLeaseRequest> leases, CancellationToken ct)
    {
        await RequireSharedScenes(sharedSession).ValidateStructureAsync(retained.DocumentUpdates, ct);
        await AcquireWritingMetadataLeasesAsync(retained.MetadataUpdates, leases, ct);
    }

    private SharedMetadataUpdate[] ReadWritingMetadata(WritingFileMutation[] mutations)
    {
        var updates = new List<SharedMetadataUpdate>();
        var root = sharedRoot ?? throw new InvalidOperationException("The shared project is closed.");
        foreach (var mutation in mutations.Where(mutation => mutation.Before is not null && mutation.After is not null && mutation.Path.EndsWith(".json", StringComparison.OrdinalIgnoreCase)))
        {
            var path = Path.GetRelativePath(root, mutation.Path).Replace('\\', '/');
            var before = JsonNode.Parse(mutation.Before ?? throw new InvalidDataException("Missing prior metadata.")) as JsonObject;
            var after = JsonNode.Parse(mutation.After ?? throw new InvalidDataException("Missing staged metadata.")) as JsonObject;
            if (before is null || after is null) continue;
            foreach (var binding in ActiveFieldBindings.Where(binding => binding.Path == path && binding.Metadata is not null))
            {
                if (SharedMetadataFields.Target(before, binding) is null || SharedMetadataFields.Target(after, binding) is null) continue;
                var old = SharedMetadataFields.Read(before, binding);
                var next = SharedMetadataFields.Read(after, binding);
                if (SharedMetadataFields.Equivalent(binding, old, next)) continue;
                updates.Add(new(binding.ItemId, old?.ToJsonString() ?? "null", next?.ToJsonString() ?? "null"));
            }
        }
        return updates.ToArray();
    }

    private async Task AcquireWritingMetadataLeasesAsync(IEnumerable<SharedMetadataUpdate> updates, List<FieldLeaseRequest> leases, CancellationToken ct)
    {
        foreach (var update in updates)
        {
            var field = await RequireEditableSharedFieldAsync(sharedSession, update.ItemId, Guid.NewGuid());
            var grant = await field.Fields.AcquireAsync(field.Lease, ct);
            if (!grant.Lease.Acquired) throw new InvalidOperationException("A collaborator is editing an affected act reference.");
            leases.Add(field.Lease);
            if (!JsonNode.DeepEquals(JsonNode.Parse(grant.Value), JsonNode.Parse(update.Before))) throw new WritingConflictException("An act reference changed before commit.");
            await ValidateSharedMetadataWriteAsync(fieldBindings[update.ItemId], JsonNode.Parse(update.After));
        }
    }

    private async Task ReleaseWritingMetadataAsync(IEnumerable<FieldLeaseRequest> leases)
    {
        if (fieldSession is not { } session) return;
        foreach (var lease in leases) await session.ReleaseFieldAsync(lease, CancellationToken.None);
    }
}
#endif
