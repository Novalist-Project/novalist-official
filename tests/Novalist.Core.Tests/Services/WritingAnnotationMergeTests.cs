using Novalist.Core.Models;
using Novalist.Core.Services;
using Xunit;

namespace Novalist.Core.Tests.Services;

public sealed class WritingAnnotationMergeTests
{
    [Fact]
    public void TouchedRecordsConflictWhileUnrelatedPeerRecordsAndProvenanceSurvive()
    {
        var original = new WritingComment("local", "anchor", "Before", false) { CreatedAt = DateTime.UnixEpoch, Author = "Writer", Replies = [new("reply", "Peer", "Reply", DateTime.UnixEpoch)] };
        var before = new WritingAnnotations([original], [new("footnote", 1, "Note")]);
        var after = new WritingAnnotations([new("local", "anchor", "After", true)], []);
        var current = before with { Comments = [original, new("peer", "", "Peer note", false)] };
        var merged = WritingAnnotationMerge.Merge(before, after, current)!;
        Assert.Equal(2, merged.Comments.Length);
        Assert.Equal("Writer", merged.Comments[0].Author);
        Assert.Single(merged.Comments[0].Replies!);
        Assert.Empty(merged.Footnotes);
        Assert.Equal("Peer note", merged.Comments[1].Text);
        Assert.Null(WritingAnnotationMerge.Merge(before, after, current with { Comments = [original with { Text = "Remote edit" }] }));
        Assert.Throws<InvalidDataException>(() => WritingAnnotationMerge.Merge(before, after with { Comments = [original, original] }, current));
    }
}
