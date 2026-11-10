namespace Novalist.Core.Models;

public sealed record SceneRef(string BookId, string DraftId, string ChapterGuid, string SceneId);

public sealed record WritingSceneSnapshot(SceneRef Ref, string Html, string Hash, long Revision);

public sealed record SceneChange(SceneRef Ref, long ExpectedRevision, string BeforeHtml, string AfterHtml, string? ExpectedHash = null);
public sealed record WritingComment(string Id, string AnchorText, string Text, bool Resolved);
public sealed record WritingFootnote(string Id, int Number, string Text);
public sealed record WritingAnnotations(WritingComment[] Comments, WritingFootnote[] Footnotes)
{
    public static WritingAnnotations FromScene(SceneData scene) => new(
        (scene.Comments ?? []).Select(comment => new WritingComment(comment.Id, comment.AnchorText, comment.Text, comment.Resolved)).ToArray(),
        (scene.Footnotes ?? []).Select(note => new WritingFootnote(note.Id, note.Number, note.Text)).ToArray());
}
public sealed record AnnotationChange(SceneRef Ref, WritingAnnotations Before, WritingAnnotations After);
public sealed record WritingCommitRequest(string TransactionId, long ExpectedEpoch, SceneChange[] Changes, AnnotationChange[] AnnotationChanges);
public sealed record WritingSceneHash(SceneRef Ref, string Hash);
public sealed record WritingCommitResult(string Status, string? OperationId = null, WritingSceneHash[]? Hashes = null,
    WritingSceneHash[]? Conflicts = null, string? ErrorCode = null);
