using System.Text.Json;
using Novalist.Core.Models;
using Novalist.Core.Services;

namespace Novalist.Backend;

public sealed class WritingMutationCoordinator(Workspace workspace)
{
    public async Task<WritingCommitResult> CommitAsync(WritingCommitRequest request, CancellationToken ct = default)
    {
        var operationId = WritingOperationJournal.OperationId(request.TransactionId);
        try
        {
            return workspace.Coordinator is { } coordinator
                ? await coordinator.RunWritingAsync(() => CommitCoreAsync(request, ct), ct)
                : await CommitCoreAsync(request, ct);
        }
        catch (Exception error) when (error is IOException or InvalidDataException or UnauthorizedAccessException
            or InvalidOperationException or JsonException or TimeoutException or OperationCanceledException)
        {
            return new("retryable", operationId, ErrorCode: "writing.commitFailed");
        }
    }

    private async Task<WritingCommitResult> CommitCoreAsync(WritingCommitRequest request, CancellationToken ct)
    {
        if (request.ExpectedEpoch != (workspace.Coordinator?.Epoch ?? 0))
            return new("retryable", WritingOperationJournal.OperationId(request.TransactionId), ErrorCode: "writing.workspaceChanged");
        var root = workspace.Projects.ProjectRoot ?? throw new InvalidOperationException("No project open.");
        var journal = new WritingOperationJournal(root, workspace.FileService);
        var fingerprint = WritingOperationJournal.OperationId(JsonSerializer.Serialize(new { request.Changes, request.AnnotationChanges }));
        await journal.RecoverAsync(ct);
        var previous = await journal.FindAsync(request.TransactionId, fingerprint);
        if (previous?.State == "committed")
        {
            await ReloadAsync();
            return new("committed", previous.OperationId, previous.Hashes);
        }
        await ValidateLocalScenesAsync(request, ct);
        var plan = await workspace.Projects.PlanWritingAsync(request, ct);
        if (plan.Conflicts.Length > 0) return new("conflict", Conflicts: plan.Conflicts);
        var files = plan.Files.ToList();
        if (plan.WordCounts.Length > 0) files.Add(await workspace.WordHistory.PlanWritingSavesAsync(plan.WordCounts));
        var operation = await journal.PrepareAsync(request.TransactionId, fingerprint, files, ct, plan.Hashes);
        await journal.CommitAsync(operation, ct);
        await ReloadAsync();
        foreach (var change in request.Changes)
        {
            if (workspace.Projects.ActiveBook?.Id != change.Ref.BookId || workspace.Projects.ActiveBook.ActiveDraftId != change.Ref.DraftId) continue;
            var (chapter, scene) = workspace.ResolveScene(change.Ref.ChapterGuid, change.Ref.SceneId);
            workspace.RaiseWritingSceneSaved(chapter, scene);
        }
        return new("committed", operation.OperationId, plan.Hashes);
    }

    private async Task ReloadAsync()
    {
        await workspace.Projects.ReloadActiveDraftAsync();
        await workspace.WordHistory.LoadAsync();
    }

    private async Task ValidateLocalScenesAsync(WritingCommitRequest request, CancellationToken ct)
    {
        var reader = new SceneDocumentReader(workspace.Projects, workspace.FileService);
        foreach (var reference in request.Changes.Select(change => change.Ref).Concat(request.AnnotationChanges.Select(change => change.Ref)).Distinct())
        {
            var scene = await reader.ResolveAsync(reference, ct);
#if NOVALIST_COLLABORATION
            workspace.RequireUnsharedWritingPath(scene.Path);
#endif
        }
    }
}
