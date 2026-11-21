using Novalist.Core.Models;
using Novalist.Core.Services;
using Xunit;
using System.Text.RegularExpressions;

namespace Novalist.Core.Tests.Services;

public sealed class WritingSearchTests
{
    private static WritingSceneSnapshot Snapshot(string id, string html) =>
        new(new("book", "draft", "chapter", id), html, ContentHasher.Hash(html), 3);

    [Fact]
    public void FindsSeparateDirtyAndOffscreenSnapshotsWithCanonicalUtf16Offsets()
    {
        var snapshots = new[] { Snapshot("dirty-visible", "<p>\U0001D11E <b>wolf</b></p>"), Snapshot("clean-offscreen", "<p>wolf</p>") };
        var matches = FindReplaceService.FindWriting(new() { Pattern = "wolf" }, snapshots);
        Assert.Equal(new[] { "dirty-visible", "clean-offscreen" }, matches.Select(match => match.Ref.SceneId));
        Assert.Equal(3, matches[0].Index);
        Assert.Empty(FindReplaceService.FindWriting(new() { Pattern = "wolf\nwolf" }, snapshots));
        var changes = FindReplaceService.PrepareWritingReplace(new() { Pattern = "wolf" }, snapshots, [matches[0]], "$1 & fox");
        Assert.Equal("<p>\U0001D11E <b>$1 &amp; fox</b></p>", Assert.Single(changes).AfterHtml);
        Assert.Equal(snapshots[0].Html, changes[0].BeforeHtml);
    }

    [Fact]
    public void RejectsChangedOrForgedMatchesAndInvalidRegex()
    {
        var snapshot = Snapshot("scene", "<p>wolf wolf</p>");
        var options = new FindOptions { Pattern = "wolf" };
        var matches = FindReplaceService.FindWriting(options, [snapshot]);
        Assert.Throws<InvalidOperationException>(() => FindReplaceService.PrepareWritingReplace(options, [snapshot with { Revision = 4 }], matches, "fox"));
        Assert.Throws<InvalidOperationException>(() => FindReplaceService.PrepareWritingReplace(options, [snapshot], [matches[0] with { Index = 1 }], "fox"));
        Assert.Throws<InvalidOperationException>(() => FindReplaceService.PrepareWritingReplace(options, [snapshot], [matches[0], matches[0]], "fox"));
        Assert.ThrowsAny<ArgumentException>(() => FindReplaceService.FindWriting(new() { Pattern = "[", UseRegex = true }, [snapshot]));
        Assert.Empty(FindReplaceService.FindWriting(new(), [snapshot]));
    }

    [Fact]
    public void RegexTimeoutDoesNotProducePartialReplacement()
    {
        var snapshot = Snapshot("scene", "<p>" + new string('a', 100_000) + "!</p>");
        Assert.Throws<RegexMatchTimeoutException>(() => FindReplaceService.FindWriting(new() { Pattern = "(a+)+$", UseRegex = true }, [snapshot]));
        Assert.EndsWith("!</p>", snapshot.Html);
    }

    [Fact]
    public void LiteralAndRegexSearchPreserveExactInlineOffsetsAndReplacementEscaping()
    {
        var snapshot = Snapshot("scene", "<p>A.b aXb <b>cat</b> cats &amp; cat</p>");
        Assert.Single(FindReplaceService.FindWriting(new() { Pattern = "a.b" }, [snapshot]));
        Assert.Equal(2, FindReplaceService.FindWriting(new() { Pattern = "a.b", UseRegex = true }, [snapshot]).Length);
        var options = new FindOptions { Pattern = "cat", WholeWord = true };
        var matches = FindReplaceService.FindWriting(options, [snapshot]);
        Assert.Equal(2, matches.Length);
        var change = Assert.Single(FindReplaceService.PrepareWritingReplace(options, [snapshot], matches, "<fox>"));
        Assert.Equal("<p>A.b aXb <b>&lt;fox&gt;</b> cats &amp; &lt;fox&gt;</p>", change.AfterHtml);
        Assert.Empty(FindReplaceService.PrepareWritingReplace(options, [snapshot], [], "fox"));
    }
}
