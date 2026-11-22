using System.Text.Json;
using Nerdbank.Streams;
using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Core.Models;
using StreamJsonRpc;
using Xunit;

namespace Novalist.Backend.Tests;

[Collection("BackendStatics")]
public sealed class WritingRpcReviewTests
{
    [Fact]
    public async Task CompleteRecordsCanClearNullableProvenanceAndLegacyNewCommentsKeepDefaults()
    {
        using var fixture = await Fixture.CreateAsync();
        fixture.SeedComment();
        fixture.Workspace.Projects.ProjectSettings.Author = "Project author";
        await fixture.Workspace.Projects.SaveScenesAsync();
        var before = await fixture.ReadAnnotationsAsync(fixture.First);
        var cleared = before.Comments[0] with { Author = null, IsTodo = false, Verdict = null, Replies = null };
        var after = new WritingAnnotations([cleared, new("new", "Anchor", "New note", false)], []);
        Assert.Equal("committed", (await fixture.CommitAsync([new(fixture.First, before, after)])).Status);
        var comments = fixture.Scene(fixture.First).Comments!;
        Assert.Null(comments[0].Author);
        Assert.False(comments[0].IsTodo);
        Assert.Null(comments[0].Verdict);
        Assert.Null(comments[0].Replies);
        Assert.Equal(before.Comments[0].CreatedAt, comments[0].CreatedAt);
        Assert.Equal("Project author", comments[1].Author);
        Assert.InRange(comments[1].CreatedAt, DateTime.UtcNow.AddMinutes(-1), DateTime.UtcNow);
    }

    [Fact]
    public async Task DuplicateReplyIdentityIsRejectedBeforeRemovingAnyComments()
    {
        using var fixture = await Fixture.CreateAsync();
        fixture.SeedComment();
        await fixture.Workspace.Projects.SaveScenesAsync();
        var before = await fixture.ReadAnnotationsAsync(fixture.First);
        var original = before.Comments[0];
        var duplicate = original with { Replies = [original.Replies![0], original.Replies[0]] };
        Assert.Equal("retryable", (await fixture.CommitAsync([new(fixture.First, before, new([duplicate], []))])).Status);
        Assert.Single(fixture.Scene(fixture.First).Comments!.Single().Replies!);
    }

    [Fact]
    public async Task CommentDeletionUndoAndTransferPreserveFullStoredRecordsThroughRpc()
    {
        using var fixture = await Fixture.CreateAsync();
        var original = fixture.SeedComment();
        await fixture.Workspace.Projects.SaveScenesAsync();
        var snapshot = await fixture.ReadAnnotationsAsync(fixture.First);
        var empty = new WritingAnnotations([], []);
        Assert.Equal("committed", (await fixture.CommitAsync([new(fixture.First, snapshot, empty)])).Status);
        Assert.Empty(fixture.Scene(fixture.First).Comments!);
        Assert.Equal("committed", (await fixture.CommitAsync([new(fixture.First, empty, snapshot)])).Status);
        Assert.Equal(original, JsonSerializer.Serialize(Assert.Single(fixture.Scene(fixture.First).Comments!)));
        var restored = await fixture.ReadAnnotationsAsync(fixture.First);
        Assert.Equal("committed", (await fixture.CommitAsync([
            new(fixture.First, restored, empty), new(fixture.Second, empty, restored)])).Status);
        Assert.Empty(fixture.Scene(fixture.First).Comments!);
        Assert.Equal(original, JsonSerializer.Serialize(Assert.Single(fixture.Scene(fixture.Second).Comments!)));
    }

    [Theory]
    [InlineData("author")]
    [InlineData("createdAt")]
    [InlineData("isTodo")]
    [InlineData("verdict")]
    [InlineData("replyText")]
    [InlineData("replyAuthor")]
    [InlineData("replyCreatedAt")]
    public async Task FullBeforeSnapshotDetectsConcurrentProvenanceChanges(string field)
    {
        using var fixture = await Fixture.CreateAsync();
        fixture.SeedComment();
        await fixture.Workspace.Projects.SaveScenesAsync();
        var snapshot = await fixture.ReadAnnotationsAsync(fixture.First);
        var stored = fixture.Scene(fixture.First).Comments!.Single();
        switch (field)
        {
            case "author": stored.Author = "Other"; break;
            case "createdAt": stored.CreatedAt = stored.CreatedAt.AddDays(1); break;
            case "isTodo": stored.IsTodo = false; break;
            case "verdict": stored.Verdict = "declined"; break;
            case "replyText": stored.Replies![0].Text = "Other"; break;
            case "replyAuthor": stored.Replies![0].Author = "Other"; break;
            case "replyCreatedAt": stored.Replies![0].CreatedAt = stored.CreatedAt; break;
        }
        await fixture.Workspace.Projects.SaveScenesAsync();
        var actual = JsonSerializer.Serialize(stored);
        var result = await fixture.CommitAsync([new(fixture.First, snapshot, new([], []))]);
        Assert.Equal("conflict", result.Status);
        Assert.Equal(actual, JsonSerializer.Serialize(fixture.Scene(fixture.First).Comments!.Single()));
    }

    [Theory]
    [InlineData("<h1>Heading</h1><p>Body</p><ul><li>First</li><li>Second</li></ul>", 4)]
    [InlineData("<table><tr><th>Heading</th><th>Other</th></tr><tr><td>First</td><td>Second</td></tr></table>", 4)]
    [InlineData("<div>First<div>Second</div>Third</div><blockquote>Fourth</blockquote><pre>Fifth</pre>", 5)]
    [InlineData("<h2>你好</h2><ul><li>世界</li><li>one <strong>two</strong></li></ul>", 6)]
    [InlineData("<div>กขคงจฉชซฌญ</div><div>word</div><div>한글</div>", 5)]
    [InlineData("<h2>Title</h2><p><del data-nl-change='old'>Removed words</del><ins data-nl-change='new'>Added word</ins></p><p><del>Struck</del></p>", 4)]
    [InlineData("<p>un<strong>broken</strong>&nbsp;word</p>", 2)]
    public async Task RichBlocksPersistCanonicalWordCountsAndHistoryDeltas(string html, int expected)
    {
        using var fixture = await Fixture.CreateAsync();
        var before = "<p>baseline</p>";
        var (chapter, scene) = fixture.Workspace.ResolveScene(fixture.First.ChapterGuid, fixture.First.SceneId);
        await fixture.Workspace.Projects.WriteSceneContentAsync(chapter, scene, before);
        await fixture.Workspace.WordHistory.RecordBaselineAsync(fixture.First.BookId, fixture.First.SceneId, 1);
        var request = new WritingCommitRequest(Guid.NewGuid().ToString(), 0, [new(fixture.First, 0, before, html)], []);
        Assert.Equal("committed", (await fixture.Rpc.InvokeAsync<WritingCommitResult>("writing/commit", request)).Status);
        Assert.Equal(expected, fixture.Scene(fixture.First).WordCount);
        var today = DateOnly.FromDateTime(DateTime.Now);
        Assert.Equal(expected - 1, fixture.Workspace.WordHistory.TotalForDay(today));
        Assert.Equal(expected, fixture.Workspace.WordHistory.ReadRange(today, today).Last().Words);
    }

    private sealed class Fixture : IDisposable
    {
        private readonly TempDir _directory = new();
        private readonly BackendHost _host;
        internal Workspace Workspace => _host.Workspace;
        internal JsonRpc Rpc { get; }
        internal SceneRef First { get; private set; } = new("", "", "", "");
        internal SceneRef Second { get; private set; } = new("", "", "", "");

        private Fixture()
        {
            _host = new BackendHost(Path.Combine(_directory.Path, "settings"));
            var (backend, desktop) = FullDuplexStream.CreatePair();
            _host.Attach(backend, backend);
            var formatter = new SystemTextJsonFormatter();
            formatter.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
            Rpc = new JsonRpc(new HeaderDelimitedMessageHandler(desktop, desktop, formatter));
            Rpc.StartListening();
        }

        internal static async Task<Fixture> CreateAsync()
        {
            var fixture = new Fixture();
            var projects = fixture.Workspace.Projects;
            await projects.CreateProjectAsync(fixture._directory.Path, "Novel", "Book");
            var chapter = await projects.CreateChapterAsync("Chapter");
            var first = await projects.CreateSceneAsync(chapter.Guid, "First");
            var second = await projects.CreateSceneAsync(chapter.Guid, "Second");
            var book = projects.ActiveBook!;
            fixture.First = new(book.Id, book.ActiveDraftId!, chapter.Guid, first.Id);
            fixture.Second = fixture.First with { SceneId = second.Id };
            return fixture;
        }

        internal SceneData Scene(SceneRef reference) => Workspace.ResolveScene(reference.ChapterGuid, reference.SceneId).scene;

        internal string SeedComment()
        {
            var created = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            var comment = new SceneComment
            {
                Id = "comment", AnchorText = "Anchor", Text = "Review", Resolved = true,
                CreatedAt = created, Author = "Original reviewer", IsTodo = true, Verdict = "accepted",
                Replies = [new() { Id = "reply", Author = "Reply author", Text = "Reply", CreatedAt = created.AddDays(1) }]
            };
            Scene(First).Comments = [comment];
            return JsonSerializer.Serialize(comment);
        }

        internal async Task<WritingAnnotations> ReadAnnotationsAsync(SceneRef reference)
            => (await Rpc.InvokeAsync<SceneContentDto>("scenes/readPassive", reference.BookId, reference.DraftId, reference.ChapterGuid, reference.SceneId)).Annotations!;

        internal Task<WritingCommitResult> CommitAsync(AnnotationChange[] changes)
            => Rpc.InvokeAsync<WritingCommitResult>("writing/commit", new WritingCommitRequest(Guid.NewGuid().ToString(), 0, [], changes));

        public void Dispose()
        {
            Rpc.Dispose();
            _host.Dispose();
            _directory.Dispose();
        }
    }
}
