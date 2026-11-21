using Novalist.Core.Models;
using Novalist.Core.Services;
using Novalist.Core.Tests.TestHelpers;
using Xunit;

namespace Novalist.Core.Tests.Services;

public sealed class ManuscriptStructureServiceTests
{
    [Fact]
    public async Task ActCommandsAndSortedMovesReuseRulesAndRestoreMetadata()
    {
        using var dir = new TempDir();
        var projects = new ProjectService(new FileService());
        await projects.CreateProjectAsync(dir.Path, "Project", "Book");
        var chapter = await projects.CreateChapterAsync("One");
        var second = await projects.CreateChapterAsync("Two");
        var third = await projects.CreateChapterAsync("Three");
        var service = new ManuscriptStructureService(projects);
        async Task<StructureCommit> Run(StructureCommand command) => await service.ExecuteAsync(new(Guid.NewGuid().ToString(), 0, projects.ActiveBook!.Id, projects.ActiveBook.ActiveDraftId, command));
        await Run(new CreateActCommand("A", null));
        await Run(new CreateActCommand("B", null));
        await Run(new MoveChaptersCommand([second.Guid, chapter.Guid], third.Guid, "A"));
        Assert.Equal(new[] { chapter.Guid, second.Guid, third.Guid }, projects.GetChaptersOrdered().Select(c => c.Guid));
        await Run(new MoveChaptersCommand([third.Guid], null, "B"));
        await Run(new MoveActCommand("B", "A"));
        Assert.Equal(third.Guid, projects.GetChaptersOrdered()[0].Guid);
        var character = new CharacterData { Name = "Person", StateOverrides = [new() { Id = "state", Act = "A" }] };
        await new EntityService(projects).SaveCharacterAsync(character);
        projects.ActiveBook!.Premise.Acts["A"] = "Premise";
        await projects.SaveProjectAsync();
        var renamed = await Run(new RenameActCommand("A", "Renamed"));
        Assert.Equal("Renamed", Assert.Single(Assert.Single(await new EntityService(projects).LoadCharactersAsync()).StateOverrides).Act);
        Assert.Equal("Premise", projects.ActiveBook!.Premise.Acts["Renamed"]);
        await service.RestoreAsync(renamed.OperationId, true);
        Assert.Equal("A", Assert.Single(Assert.Single(await new EntityService(projects).LoadCharactersAsync()).StateOverrides).Act);
        Assert.Equal("Premise", projects.ActiveBook!.Premise.Acts["A"]);
        await Run(new RemoveActCommand("B"));
        var inserted = await Run(new InsertSceneCommand(chapter.Guid, "First", null));
        var ahead = await Run(new InsertSceneCommand(chapter.Guid, "Ahead", inserted.FocusScene!.SceneId));
        await Run(new MoveScenesCommand([inserted.FocusScene.SceneId, ahead.FocusScene!.SceneId], second.Guid, null));
        Assert.Equal(new[] { "Ahead", "First" }, projects.GetScenesForChapter(second.Guid).Select(s => s.Title));
        await Assert.ThrowsAsync<InvalidOperationException>(() => Run(new MoveScenesCommand(["missing"], second.Guid, null)));
        await Assert.ThrowsAsync<InvalidOperationException>(() => Run(new MoveChaptersCommand([chapter.Guid], null, "missing")));
        await Assert.ThrowsAsync<InvalidOperationException>(() => Run(new InsertChapterCommand(" ", null, null)));
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.ExecuteAsync(new("stale", 0, "other", "draft", new CreateActCommand("Other", null))));
    }

    [Fact]
    public async Task LegacyActsNeedExplicitPreviewAndSplitAtEdgesRetainsAnnotations()
    {
        using var dir = new TempDir();
        var projects = new ProjectService(new FileService());
        await projects.CreateProjectAsync(dir.Path, "Project", "Book");
        var one = await projects.CreateChapterAsync("One");
        var two = await projects.CreateChapterAsync("Two");
        var three = await projects.CreateChapterAsync("Three");
        one.Act = three.Act = "A";
        two.Act = "B";
        await projects.SaveProjectAsync();
        var service = new ManuscriptStructureService(projects);
        StructureRequest Request(StructureCommand command) => new(Guid.NewGuid().ToString(), 0, projects.ActiveBook!.Id, projects.ActiveBook.ActiveDraftId, command);
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.ExecuteAsync(Request(new CreateActCommand("C", null))));
        var preview = new ActStructureService(projects).PreviewRegroup(projects.ActiveBook!);
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.ExecuteAsync(Request(new RegroupActsCommand(preview.RevisionToken, "stale"))));
        await service.ExecuteAsync(Request(new RegroupActsCommand(preview.RevisionToken, preview.RevisionToken)));
        var scene = await projects.CreateSceneAsync(one.Guid, "Scene");
        scene.Comments = [new() { Id = "comment", Author = "Writer", Text = "Note" }];
        await projects.SaveScenesAsync();
        const string html = "<p data-comment-id=\"comment\">Words</p>";
        await projects.WriteSceneContentAsync(projects.GetChaptersOrdered().First(c => c.Guid == one.Guid), scene, html);
        var reference = new SceneRef(projects.ActiveBook!.Id, projects.ActiveBook.ActiveDraftId, one.Guid, scene.Id);
        await service.ExecuteAsync(Request(new SplitSceneCommand(reference, "", html, html, ContentHasher.Hash(html))));
        Assert.Equal("Writer", Assert.Single(projects.GetScenesForChapter(one.Guid).Last().Comments!).Author);
        await service.ExecuteAsync(Request(new SplitSceneCommand(reference, "", "", "", ContentHasher.Hash(""))));
        Assert.Equal(3, projects.GetScenesForChapter(one.Guid).Count);
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.PlanAsync(Request(new SplitSceneCommand(reference with { DraftId = "other" }, "", "", "", ContentHasher.Hash("")))));
        await Assert.ThrowsAsync<InvalidDataException>(() => service.PlanAsync(Request(new UnsupportedCommand())));
    }

    private sealed record UnsupportedCommand : StructureCommand;

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    public async Task PartialWriteFailureRollsBackBeforePublishingAndCanRetry(int failAt)
    {
        using var dir = new TempDir();
        var files = new FailingFiles();
        var projects = new ProjectService(files);
        await projects.CreateProjectAsync(dir.Path, "Project", "Book");
        var original = Directory.GetFiles(projects.ProjectRoot!, "*", SearchOption.AllDirectories).ToDictionary(path => path, File.ReadAllText);
        var request = new StructureRequest("insert", 0, projects.ActiveBook!.Id, projects.ActiveBook.ActiveDraftId, new InsertChapterCommand("New", null, null));
        files.FailAt = failAt;
        await Assert.ThrowsAsync<IOException>(() => new ManuscriptStructureService(projects).ExecuteAsync(request));
        Assert.Empty(projects.GetChaptersOrdered());
        foreach (var file in original) Assert.Equal(file.Value, File.ReadAllText(file.Key));
        await new ManuscriptStructureService(projects).ExecuteAsync(request);
        Assert.Single(projects.GetChaptersOrdered());
    }

    private sealed class FailingFiles : FileService, IFileService
    {
        internal int FailAt { get; set; }
        Task IFileService.WriteTextAsync(string path, string content)
        {
            if (FailAt > 0 && --FailAt == 0) throw new IOException("Injected structure write failure.");
            return WriteTextAsync(path, content);
        }
    }

    [Fact]
    public async Task SplitChapterCommitsOneRecoverableOperationAndUndoPreservesRemoteEdits()
    {
        using var dir = new TempDir();
        var projects = new ProjectService(new FileService());
        await projects.CreateProjectAsync(dir.Path, "Project", "Book");
        var chapter = await projects.CreateChapterAsync("Chapter");
        var original = await projects.CreateSceneAsync(chapter.Guid, "Original");
        await projects.WriteSceneContentAsync(chapter, original, "<p>First</p><p>Second</p>");
        var following = await projects.CreateSceneAsync(chapter.Guid, "Following scene");
        var reference = new SceneRef(projects.ActiveBook!.Id, projects.ActiveBook.ActiveDraftId, chapter.Guid, original.Id);
        var service = new ManuscriptStructureService(projects);
        var request = new StructureRequest("split", 0, reference.BookId, reference.DraftId,
            new SplitChapterCommand(reference, "New chapter", "<p>First</p>", "<p>Second</p>", "<p>First</p><p>Second</p>", ContentHasher.Hash("<p>First</p><p>Second</p>")));
        var result = await service.ExecuteAsync(request);
        Assert.NotNull(result.FocusScene);
        Assert.Equal(2, projects.GetChaptersOrdered().Count);
        var created = projects.GetChaptersOrdered().Last();
        Assert.Equal(new[] { "Original (2)", "Following scene" }, projects.GetScenesForChapter(created.Guid).Select(s => s.Title));
        await service.RestoreAsync(result.OperationId, true);
        Assert.Single(projects.GetChaptersOrdered());
        Assert.Equal(new[] { original.Id, following.Id }, projects.GetScenesForChapter(chapter.Guid).Select(s => s.Id));
        await service.RestoreAsync(result.OperationId, false);
        var moved = projects.GetScenesForChapter(created.Guid).Last();
        await projects.WriteSceneContentAsync(created, moved, "Remote work");
        await Assert.ThrowsAsync<WritingConflictException>(() => service.RestoreAsync(result.OperationId, true));
        Assert.Equal("Remote work", await projects.ReadSceneContentAsync(created, moved));
    }

    [Fact]
    public async Task InsertingIntoEmptyBookCreatesOneEmptySceneAndRetryKeepsIdentity()
    {
        using var dir = new TempDir();
        var projects = new ProjectService(new FileService());
        await projects.CreateProjectAsync(dir.Path, "Project", "Book");
        var book = projects.ActiveBook!;
        var service = new ManuscriptStructureService(projects);
        var request = new StructureRequest("insert", 0, book.Id, book.ActiveDraftId, new InsertChapterCommand("Start", null, null));
        var first = await service.ExecuteAsync(request);
        var retry = await service.ExecuteAsync(request);
        Assert.Equal(first.FocusScene, retry.FocusScene);
        Assert.Single(projects.GetScenesForChapter(Assert.Single(projects.GetChaptersOrdered()).Guid));
        await service.RestoreAsync(first.OperationId, true);
        Assert.Empty(projects.GetChaptersOrdered());
    }
}
