using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Xunit;
using Nerdbank.Streams;
using StreamJsonRpc;
using System.Text.Json;

namespace Novalist.Backend.Tests;

[Collection("BackendStatics")]
public sealed class WritingSearchRpcTests
{
    [Fact]
    public async Task RendererContractReachesRegisteredHostWithoutWriting()
    {
        using var directory = new TempDir();
        var workspace = new Workspace(directory.Path);
        await workspace.Projects.CreateProjectAsync(directory.Path, "Novel", "Book");
        var chapter = await workspace.Projects.CreateChapterAsync("Chapter");
        var scene = await workspace.Projects.CreateSceneAsync(chapter.Guid, "Scene");
        await workspace.Projects.WriteSceneContentAsync(chapter, scene, "<p>wolf</p>");
        var reference = new SceneRef(workspace.Projects.ActiveBook!.Id, workspace.Projects.ActiveBook.ActiveDraftId!, chapter.Guid, scene.Id);
        var (server, stream) = FullDuplexStream.CreatePair();
        await using var host = new BackendHost(workspace);
        host.Attach(server, server);
        var formatter = new SystemTextJsonFormatter();
        formatter.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
        using var client = new JsonRpc(new HeaderDelimitedMessageHandler(stream, stream, formatter));
        client.StartListening();
        var request = new WritingSearchRequest(new() { Pattern = "wolf" }, [reference], [], 0);
        var matches = await client.InvokeAsync<WritingMatch[]>("writingSearch/find", request);
        Assert.Equal("wolf", Assert.Single(matches).MatchedText);
        var changes = await client.InvokeAsync<Novalist.Core.Models.SceneChange[]>("writingSearch/prepareReplace", request, matches, "fox");
        Assert.Equal("<p>fox</p>", Assert.Single(changes).AfterHtml);
        Assert.Equal("<p>wolf</p>", await workspace.Projects.ReadSceneContentAsync(chapter, scene));
    }

    [Fact]
    public async Task FindRetainsItsCapturedProseAfterAutosaveWhileReplacementRejectsTheStaleBase()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var projects = workspace.Projects;
        await projects.CreateProjectAsync(directory.Path, "Novel", "Book");
        var chapter = await projects.CreateChapterAsync("Chapter");
        var scene = await projects.CreateSceneAsync(chapter.Guid, "Scene");
        await projects.WriteSceneContentAsync(chapter, scene, "<p>old</p>");
        var reference = new SceneRef(projects.ActiveBook!.Id, projects.ActiveBook.ActiveDraftId!, chapter.Guid, scene.Id);
        var request = new WritingSearchRequest(new() { Pattern = "wolf" }, [reference],
            [new(reference, "<p>captured wolf</p>", ContentHasher.Hash("<p>old</p>"), 2)], 0);
        await projects.WriteSceneContentAsync(chapter, scene, "<p>newer wolf</p>");

        var rpc = new WritingSearchRpc(workspace);
        var matches = await rpc.FindAsync(request, default);
        Assert.Equal(9, Assert.Single(matches).Index);
        Assert.Equal(2, matches[0].Revision);
        await Assert.ThrowsAsync<InvalidOperationException>(() => rpc.PrepareReplaceAsync(request, matches, "fox", default));
        await Assert.ThrowsAsync<InvalidOperationException>(() => rpc.ReplaceNotesAsync(request, "fox", default));
        Assert.Equal("<p>newer wolf</p>", await projects.ReadSceneContentAsync(chapter, scene));
    }

    [Fact]
    public async Task OptionalFieldsArePassiveAndNotesReplacementKeepsProseAndSnapshotsSeparate()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var projects = workspace.Projects;
        await projects.CreateProjectAsync(directory.Path, "Novel", "First");
        var chapter = await projects.CreateChapterAsync("Chapter");
        var scene = await projects.CreateSceneAsync(chapter.Guid, "Scene");
        var hidden = await projects.CreateSceneAsync(chapter.Guid, "Hidden");
        scene.Notes = "wolf note";
        scene.Synopsis = "wolf synopsis";
        scene.Comments = [new() { Id = "comment", Text = "wolf conversation" }];
        hidden.Notes = "wolf hidden";
        await projects.WriteSceneContentAsync(chapter, scene, "<p>wolf prose</p>");
        await projects.SaveScenesAsync();
        await new EntityService(projects).SaveCharacterAsync(new() { Id = "person", Name = "Wolf" });
        var reference = new SceneRef(projects.ActiveBook!.Id, projects.ActiveBook.ActiveDraftId!, chapter.Guid, scene.Id);
        var rpc = new WritingSearchRpc(workspace);
        var request = new WritingSearchRequest(new() { Pattern = "wolf", IncludeSceneNotes = true, IncludeCodex = true }, [reference], [], 0);
        var found = await rpc.FindAsync(request, default);
        Assert.Equal(new[] { "prose", "synopsis", "notes", "comment", "codex" }, found.Select(match => match.Field));
        Assert.Equal(2, await rpc.ReplaceNotesAsync(request, "fox", default));
        Assert.Equal("wolf hidden", hidden.Notes);
        Assert.Equal("fox note", scene.Notes);
        Assert.Equal("wolf conversation", scene.Comments[0].Text);
        Assert.Equal("<p>wolf prose</p>", await projects.ReadSceneContentAsync(chapter, scene));
        Assert.NotEmpty(await new SnapshotService(projects, workspace.FileService).ListAsync(scene));
        Assert.Empty(await rpc.FindAsync(request with { Options = new() }, default));
    }

    [Fact]
    public async Task SearchCapturesDirtyAndOffscreenProseWithoutSavingOrSwitchingBooks()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var projects = workspace.Projects;
        await projects.CreateProjectAsync(directory.Path, "Novel", "First");
        var chapter = await projects.CreateChapterAsync("First chapter");
        var scene = await projects.CreateSceneAsync(chapter.Guid, "Visible");
        await projects.WriteSceneContentAsync(chapter, scene, "<p>old</p>");
        var first = new SceneRef(projects.ActiveBook!.Id, projects.ActiveBook.ActiveDraftId!, chapter.Guid, scene.Id);
        var secondBook = await projects.CreateBookAsync("Second");
        await projects.SwitchBookAsync(secondBook.Id);
        var secondChapter = await projects.CreateChapterAsync("Other");
        var secondScene = await projects.CreateSceneAsync(secondChapter.Guid, "Offscreen");
        await projects.WriteSceneContentAsync(secondChapter, secondScene, "<p>wolf</p>");
        await projects.SwitchBookAsync(first.BookId);
        var rpc = new WritingSearchRpc(workspace);
        var targets = await rpc.TargetsAsync(first.BookId, first.DraftId, true, default);
        Assert.Equal(2, targets.Length);
        var request = new WritingSearchRequest(new() { Pattern = "wolf" }, targets.Select(target => target.Ref).ToArray(),
            [new(first, "<p>dirty wolf</p>", ContentHasher.Hash("<p>old</p>"), 2)], 0);
        var matches = await rpc.FindAsync(request, default);
        Assert.Equal(new[] { scene.Id, secondScene.Id }, matches.Select(match => match.Ref.SceneId));
        var changes = await rpc.PrepareReplaceAsync(request, matches, "fox", default);
        Assert.Equal("<p>dirty fox</p>", changes[0].AfterHtml);
        Assert.Equal(first.BookId, projects.ActiveBook.Id);
        Assert.Equal("<p>old</p>", (await new SceneDocumentReader(projects, workspace.FileService).ReadAsync(first)).Html);
        Assert.Single(await rpc.TargetsAsync(first.BookId, first.DraftId, false, default));
        await Assert.ThrowsAsync<InvalidOperationException>(() => rpc.FindAsync(request with { ExpectedEpoch = 1 }, default));
        await Assert.ThrowsAsync<InvalidOperationException>(() => rpc.FindAsync(request with { Targets = [first, first] }, default));
        await Assert.ThrowsAsync<InvalidOperationException>(() => rpc.FindAsync(request with { Targets = [] }, default));
        await projects.WriteSceneContentAsync(chapter, scene, "<p>external wolf</p>");
        await Assert.ThrowsAsync<InvalidOperationException>(() => rpc.PrepareReplaceAsync(request, matches, "fox", default));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => rpc.FindAsync(request, new CancellationToken(true)));
    }
}
