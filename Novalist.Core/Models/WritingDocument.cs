namespace Novalist.Core.Models;

public sealed record SceneRef(string BookId, string DraftId, string ChapterGuid, string SceneId);

public sealed record WritingSceneSnapshot(SceneRef Ref, string Html, string Hash, long Revision);

public sealed record SceneChange(SceneRef Ref, long ExpectedRevision, string BeforeHtml, string AfterHtml, string? ExpectedHash = null);
public sealed record WritingComment(string Id, string AnchorText, string Text, bool Resolved)
{
    /// <summary>Present on complete stored snapshots; absent on legacy partial editor records.</summary>
    public DateTime? CreatedAt { get; init; }
    public string? Author { get; init; }
    public bool? IsTodo { get; init; }
    public string? Verdict { get; init; }
    public WritingCommentReply[]? Replies { get; init; }

    public static WritingComment FromScene(SceneComment comment) => new(comment.Id, comment.AnchorText, comment.Text, comment.Resolved)
    {
        CreatedAt = comment.CreatedAt, Author = comment.Author, IsTodo = comment.IsTodo, Verdict = comment.Verdict,
        Replies = comment.Replies?.Select(reply => new WritingCommentReply(reply.Id, reply.Author, reply.Text, reply.CreatedAt)).ToArray()
    };

    public bool Matches(WritingComment actual)
        => Id == actual.Id && AnchorText == actual.AnchorText && Text == actual.Text && Resolved == actual.Resolved
            && (!CreatedAt.HasValue || CreatedAt == actual.CreatedAt)
            && (!(CreatedAt.HasValue || Author is not null) || Author == actual.Author)
            && (!IsTodo.HasValue || IsTodo == actual.IsTodo)
            && (!(CreatedAt.HasValue || Verdict is not null) || Verdict == actual.Verdict)
            && (!(CreatedAt.HasValue || Replies is not null)
                || (Replies is null ? actual.Replies is null : actual.Replies is not null && Replies.SequenceEqual(actual.Replies)));

    public void ApplyTo(SceneComment stored)
    {
        stored.AnchorText = AnchorText;
        stored.Text = Text;
        stored.Resolved = Resolved;
        if (CreatedAt is { } created) stored.CreatedAt = created;
        if (CreatedAt.HasValue || Author is not null) stored.Author = Author;
        if (IsTodo is { } todo) stored.IsTodo = todo;
        if (CreatedAt.HasValue || Verdict is not null) stored.Verdict = Verdict;
        if (CreatedAt.HasValue || Replies is not null)
            stored.Replies = Replies?.Select(reply => new CommentReply
            {
                Id = reply.Id, Author = reply.Author, Text = reply.Text, CreatedAt = reply.CreatedAt
            }).ToList();
    }
}
public sealed record WritingCommentReply(string Id, string Author, string Text, DateTime CreatedAt);
public sealed record WritingFootnote(string Id, int Number, string Text);
public sealed record WritingAnnotations(WritingComment[] Comments, WritingFootnote[] Footnotes)
{
    public static WritingAnnotations FromScene(SceneData scene) => new(
        (scene.Comments ?? []).Select(WritingComment.FromScene).ToArray(),
        (scene.Footnotes ?? []).Select(note => new WritingFootnote(note.Id, note.Number, note.Text)).ToArray());
}
public sealed record AnnotationChange(SceneRef Ref, WritingAnnotations Before, WritingAnnotations After);
public sealed record WritingCommitRequest(string TransactionId, long ExpectedEpoch, SceneChange[] Changes, AnnotationChange[] AnnotationChanges);
public sealed record WritingSceneHash(SceneRef Ref, string Hash);
public sealed record WritingCommitResult(string Status, string? OperationId = null, WritingSceneHash[]? Hashes = null,
    WritingSceneHash[]? Conflicts = null, string? ErrorCode = null);
