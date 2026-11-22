using System.Text.Json;
using Novalist.Core.Models;
using Novalist.Core.Services;
using StreamJsonRpc;

namespace Novalist.Backend.Rpc;

public sealed partial class WritingRpc
{
    [JsonRpcMethod("writing/structure")]
    public Task<StructureResult> StructureAsync(StructureRequest request)
        => RunStructureAsync(request.ExpectedEpoch, WritingOperationJournal.OperationId(request.TransactionId),
#if NOVALIST_COLLABORATION
            () => workspace.ExecuteWritingStructureAsync(request));
#else
            () => new ManuscriptStructureService(workspace.Projects).ExecuteAsync(request));
#endif

    [JsonRpcMethod("writing/undoStructure")]
    public Task<StructureResult> UndoStructureAsync(string operationId, long expectedEpoch, SharedStructureInverse? sharedInverse = null)
#if NOVALIST_COLLABORATION
        => RunStructureAsync(expectedEpoch, operationId, () => workspace.RestoreWritingStructureAsync(operationId, true, sharedInverse));
#else
        => RunStructureAsync(expectedEpoch, operationId, () => new ManuscriptStructureService(workspace.Projects).RestoreAsync(operationId, true));
#endif

    [JsonRpcMethod("writing/redoStructure")]
    public Task<StructureResult> RedoStructureAsync(string operationId, long expectedEpoch, SharedStructureInverse? sharedInverse = null)
#if NOVALIST_COLLABORATION
        => RunStructureAsync(expectedEpoch, operationId, () => workspace.RestoreWritingStructureAsync(operationId, false, sharedInverse));
#else
        => RunStructureAsync(expectedEpoch, operationId, () => new ManuscriptStructureService(workspace.Projects).RestoreAsync(operationId, false));
#endif

    [JsonRpcMethod("writing/previewRegroup")]
    public ActRegroupPreview PreviewRegroup(string bookId, string draftId, long expectedEpoch)
    {
        var book = workspace.Projects.ActiveBook ?? throw new InvalidOperationException("No project open.");
        if (expectedEpoch != (workspace.Coordinator?.Epoch ?? 0) || book.Id != bookId || book.ActiveDraftId != draftId)
            throw new InvalidOperationException("writing.workspaceChanged");
        return new ActStructureService(workspace.Projects).PreviewRegroup(book);
    }

    private async Task<StructureResult> RunStructureAsync(long expectedEpoch, string operationId, Func<Task<StructureCommit>> execute)
    {
        if (expectedEpoch != (workspace.Coordinator?.Epoch ?? 0)) return new("retryable", operationId, ErrorCode: "writing.workspaceChanged");
        try
        {
            var committed = await execute();
            return new("committed", committed.OperationId, workspace.BuildState(), committed.Hashes, committed.FocusScene);
        }
        catch (WritingConflictException)
        {
            return new("conflict", operationId, ErrorCode: "writing.structureConflict");
        }
#if NOVALIST_COLLABORATION
        catch (Novalist.Sync.Client.SharedProjectConflictException)
        {
            return new("conflict", operationId, ErrorCode: "writing.structureConflict");
        }
#endif
        catch (Exception error) when (error is IOException or InvalidOperationException or InvalidDataException or UnauthorizedAccessException or JsonException or TimeoutException)
        {
            return new("retryable", operationId, ErrorCode: "writing.structureFailed");
        }
    }
}

public sealed record StructureResult(string Status, string? OperationId = null, ProjectStateDto? State = null,
    WritingSceneHash[]? Hashes = null, SceneRef? FocusScene = null, string? ErrorCode = null);
