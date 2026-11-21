namespace Novalist.Core.Models;

public sealed record WritingSharedAnnotationRequest(string TransactionId, long ExpectedEpoch, AnnotationChange[] Changes);
public sealed record WritingAnnotationSnapshot(SceneRef Ref, WritingAnnotations Annotations);
public sealed record WritingSharedAnnotationResult(string Status, string? OperationId = null,
    WritingAnnotationSnapshot[]? Annotations = null, SceneRef[]? Conflicts = null, string? ErrorCode = null);
