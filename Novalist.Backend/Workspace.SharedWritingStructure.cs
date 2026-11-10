#if NOVALIST_COLLABORATION
using System.Text.Json;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Novalist.Sync.Client;

namespace Novalist.Backend;

public sealed partial class Workspace
{
    private sealed record SharedStructureReceipt(string BookId, string DraftId, StructureCommit Commit,
        SharedFileChange[] Changes, SharedProjectState BeforeBindings, SharedProjectState AfterBindings,
        SharedSplitPreparation? Split, SharedMetadataUpdate[] MetadataUpdates);

    internal async Task<StructureCommit> ExecuteWritingStructureAsync(StructureRequest request)
    {
        if (sharedProjectFiles is not { } files) return await new ManuscriptStructureService(Projects).ExecuteAsync(request);
        var operationId = WritingOperationJournal.OperationId(request.TransactionId);
        var fingerprint = WritingOperationJournal.OperationId(JsonSerializer.Serialize(new { request.BookId, request.DraftId, request.Command }));
        var leases = new List<FieldLeaseRequest>();
        try
        {
        var result = await files.CommitStrictAsync("structure:" + operationId, fingerprint, async (canonical, ct) =>
        {
            await RequireSharedScenes(sharedSession).RefreshAsync(ct);
            var split = request.Command switch { SplitSceneCommand scene => scene.SharedSplit, SplitChapterCommand chapter => chapter.SharedSplit, _ => null };
            if (request.Command is SplitSceneCommand or SplitChapterCommand) await ValidateSharedSplitAsync(request.Command, split, ct);
            var plan = await new ManuscriptStructureService(Projects).PlanAsync(request, ct);
            var changes = new List<SharedFileChange>();
            foreach (var mutation in plan.Files)
            {
                if (SharedWritePath(mutation.Path) is null) continue;
                await ValidateSharedWriteAsync(mutation.Path, null, structural: false);
                changes.Add(SharedWritingChange(mutation, canonical));
            }
            var bindings = await CaptureWritingBindingsAsync(changes, split, ct);
            var metadata = ReadWritingMetadata(plan.Files);
            var beforeBindings = await files.SnapshotStateAsync(ct);
            var commit = new StructureCommit(operationId, plan.Hashes, plan.FocusScene);
            var receipt = new SharedStructureReceipt(request.BookId, request.DraftId, commit, changes.ToArray(), beforeBindings, bindings, split, metadata);
            var batch = new SharedProjectCommit(changes, bindings, JsonSerializer.Serialize(receipt))
            {
                DocumentUpdates = split is null ? [] : [new(split.ItemId, split.RetainedUpdate)], MetadataUpdates = metadata
            };
            await ValidateWritingCommitAsync(batch, leases, ct);
            return batch;
        }, CancellationToken.None, (retained, ct) => ValidateWritingCommitAsync(retained, leases, ct));
        return (JsonSerializer.Deserialize<SharedStructureReceipt>(result) ?? throw new InvalidDataException("Invalid shared structure receipt.")).Commit;
        }
        finally { await ReleaseWritingMetadataAsync(leases); }
    }

    private async Task ValidateSharedSplitAsync(StructureCommand command, SharedSplitPreparation? split, CancellationToken ct)
    {
        if (split is null || split.SessionId != sharedSession || split.CreatedItemId == Guid.Empty || split.CreatedItemId == split.ItemId
            || sharedSceneFiles.ContainsKey(split.CreatedItemId)) throw new InvalidOperationException("The shared split needs prepared collaborative edits.");
        var reference = command is SplitSceneCommand scene ? scene.Ref : ((SplitChapterCommand)command).Ref;
        var resolved = await new SceneDocumentReader(Projects, FileService).ResolveAsync(reference, ct);
        var relative = Path.GetRelativePath(sharedRoot ?? throw new InvalidOperationException("The shared project is closed."), resolved.Path).Replace('\\', '/');
        if (!sharedItems.TryGetValue(relative, out var item) || item != split.ItemId) throw new InvalidOperationException("The shared scene identity changed.");
        var current = await RequireSharedScenes(sharedSession).ReadAsync(item, ct);
        if (!current.State.AsSpan().SequenceEqual(split.SourceState)) throw new WritingConflictException("The shared scene changed before splitting.");
        await RequireSharedScenes(sharedSession).ValidateStructureAsync([new(item, split.RetainedUpdate)], ct);
        var factory = CreateSharedDocuments ?? throw new InvalidOperationException("Desktop collaboration is unavailable.");
        await using var host = factory(Guid.NewGuid());
        await host.OpenAsync(ct);
        await host.LoadAsync(split.ItemId, split.SourceState, [], ct);
        if (!(await host.ReceiveAsync(split.ItemId, split.RetainedUpdate, ct)).Accepted) throw new InvalidDataException("Invalid shared split update.");
        await host.LoadAsync(split.CreatedItemId, split.CreatedState, [], ct);
        var retained = await host.CaptureAsync(split.ItemId, ct);
        var created = await host.CaptureAsync(split.CreatedItemId, ct);
        var before = command is SplitSceneCommand one ? one.BeforeHtml : ((SplitChapterCommand)command).BeforeHtml;
        var after = command is SplitSceneCommand two ? two.AfterHtml : ((SplitChapterCommand)command).AfterHtml;
        if (retained.Html != before || created.Html != after) throw new InvalidDataException("Prepared shared split content differs from its writing command.");
    }
}
#endif
