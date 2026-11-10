#if NOVALIST_COLLABORATION
using System.Text;
using System.Text.Json;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Novalist.Sync.Client;

namespace Novalist.Backend;

public sealed partial class Workspace
{
    internal async Task<WritingSharedAnnotationResult> CommitSharedWritingAnnotationsAsync(WritingSharedAnnotationRequest request)
    {
        var operationId = WritingOperationJournal.OperationId(request.TransactionId);
        try
        {
            return Coordinator is { } coordinator
                ? await coordinator.RunWritingAsync(() => CommitSharedAnnotationsCoreAsync(request, operationId), CancellationToken.None)
                : await CommitSharedAnnotationsCoreAsync(request, operationId);
        }
        catch (SharedAnnotationConflict error) { return new("conflict", Conflicts: error.References); }
        catch (Exception error) when (error is IOException or InvalidOperationException or InvalidDataException or UnauthorizedAccessException or JsonException or TimeoutException)
        {
            return new("retryable", operationId, ErrorCode: "writing.sharedAnnotationsFailed");
        }
    }

    private async Task<WritingSharedAnnotationResult> CommitSharedAnnotationsCoreAsync(WritingSharedAnnotationRequest request, string operationId)
    {
        if (request.ExpectedEpoch != (Coordinator?.Epoch ?? 0)) return new("retryable", operationId, ErrorCode: "writing.workspaceChanged");
        var files = sharedProjectFiles ?? throw new InvalidOperationException("The shared project is closed.");
        if (request.Changes.Length == 0 || request.Changes.Select(change => change.Ref).Distinct().Count() != request.Changes.Length)
            throw new InvalidDataException("Invalid shared annotation changes.");
        var fingerprint = WritingOperationJournal.OperationId(JsonSerializer.Serialize(request.Changes));
        var receipt = await files.CommitStrictAsync(request.TransactionId, fingerprint, async (canonical, ct) =>
        {
            var merged = await MergeSharedAnnotationsAsync(request.Changes, ct);
            var plan = await Projects.PlanWritingAsync(new(request.TransactionId, request.ExpectedEpoch, [], merged), ct);
            if (plan.Conflicts.Length > 0) throw new SharedAnnotationConflict(plan.Conflicts.Select(conflict => conflict.Ref).ToArray());
            var changes = plan.Files.Select(file => SharedWritingChange(file, canonical)).ToArray();
            var result = new WritingSharedAnnotationResult("committed", operationId, merged.Select(change => new WritingAnnotationSnapshot(change.Ref, change.After)).ToArray());
            return new(changes, new([], []), JsonSerializer.Serialize(result));
        }, CancellationToken.None);
        return JsonSerializer.Deserialize<WritingSharedAnnotationResult>(receipt) ?? throw new InvalidDataException("Invalid shared annotation receipt.");
    }

    private async Task<AnnotationChange[]> MergeSharedAnnotationsAsync(AnnotationChange[] changes, CancellationToken ct)
    {
        var reader = new SceneDocumentReader(Projects, FileService);
        var merged = new List<AnnotationChange>();
        var conflicts = new List<SceneRef>();
        foreach (var change in changes)
        {
            var resolved = await reader.ResolveAsync(change.Ref, ct);
            if (sharedRoot is null || !sharedItems.ContainsKey(Path.GetRelativePath(sharedRoot, resolved.Path).Replace('\\', '/')))
                throw new InvalidOperationException("The scene is not shared.");
            await ValidateSharedWriteAsync(Path.Combine(resolved.DraftRoot, "scenes.json"), null, structural: false);
            var current = WritingAnnotations.FromScene(resolved.Scene);
            var after = WritingAnnotationMerge.Merge(change.Before, change.After, current);
            if (after is null) conflicts.Add(change.Ref);
            else merged.Add(new(change.Ref, current, after));
        }
        if (conflicts.Count > 0) throw new SharedAnnotationConflict(conflicts.ToArray());
        return merged.ToArray();
    }

    private SharedFileChange SharedWritingChange(WritingFileMutation mutation, IReadOnlyDictionary<string, byte[]> canonical)
    {
        var root = sharedRoot ?? throw new InvalidOperationException("The shared project is closed.");
        var path = Path.GetRelativePath(root, mutation.Path).Replace('\\', '/');
        var before = canonical.GetValueOrDefault(path);
        byte[]? Mask(string? content) => content is null ? null : MaskSeparatelySharedContent(path, Encoding.UTF8.GetBytes(content), before);
        return new(path, Mask(mutation.Before), Mask(mutation.After));
    }

    private sealed class SharedAnnotationConflict(SceneRef[] references) : Exception
    {
        internal SceneRef[] References { get; } = references;
    }
}
#endif
