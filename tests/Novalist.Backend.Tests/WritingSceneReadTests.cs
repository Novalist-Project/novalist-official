using Novalist.Backend.Tests.TestHelpers;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Novalist.Backend.Rpc;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed class WritingSceneReadTests
{
    [Fact]
    public async Task ActivationRejectsObsoleteFocusAndGenerationBeforePublishing()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        await workspace.Projects.CreateProjectAsync(directory.Path, "Novel", "Book");
        var chapter = await workspace.Projects.CreateChapterAsync("Chapter");
        var scene = await workspace.Projects.CreateSceneAsync(chapter.Guid, "Scene");
        var book = workspace.Projects.ActiveBook!;
        using var gate = new SemaphoreSlim(1, 1);
        workspace.Coordinator = new WorkspaceCoordinator(workspace, gate);
        var rpc = new ScenesRpc(workspace);
        Assert.False(rpc.Activate(book.Id, book.ActiveDraftId!, chapter.Guid, scene.Id, 0, "pane", 1, 1));
        Assert.Throws<InvalidOperationException>(() => rpc.SetFocusedWritingOwner("1", "pane", 0, 1));
        _ = workspace.ExtensionsHost;
        var opened = 0;
        workspace.HostServices!.SceneOpened += _ => opened++;
        using (WorkspaceRequestContext.Enter(new("0", 0, null), null))
        {
            Assert.Throws<InvalidOperationException>(() => rpc.SetFocusedWritingOwner("1", "pane", 0, -1));
            rpc.SetFocusedWritingOwner("1", "pane", 1, 1);
            rpc.SetFocusedWritingOwner("1", "pane", 0, 2);
            rpc.SetFocusedWritingOwner("2", "other", 0, 1);
        }
        using (WorkspaceRequestContext.Enter(new("1", 0, null), null))
        {
            Assert.False(rpc.Activate(book.Id, book.ActiveDraftId!, chapter.Guid, scene.Id, 0, "pane", 1, 1));
            Assert.True(rpc.Activate(book.Id, book.ActiveDraftId!, chapter.Guid, scene.Id, 0, "pane", 2, 2));
            Assert.False(rpc.Activate(book.Id, book.ActiveDraftId!, chapter.Guid, scene.Id, 0, "pane", 2, 1));
            Assert.False(rpc.Activate(book.Id, book.ActiveDraftId!, chapter.Guid, scene.Id, 1, "pane", 2, 3));
        }
        using (WorkspaceRequestContext.Enter(new("2", 0, null), null))
            Assert.False(rpc.Activate(book.Id, book.ActiveDraftId!, chapter.Guid, scene.Id, 0, "pane", 2, 3));
        Assert.Equal(1, opened);
        await rpc.ReadAsync(chapter.Guid, scene.Id);
        Assert.Equal(2, opened);
    }

    [Fact]
    public async Task PassiveReadUsesExplicitBookAndDraftWithoutActivation()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        await workspace.Projects.CreateProjectAsync(directory.Path, "Novel", "Book");
        var projects = workspace.Projects;
        var book = projects.ActiveBook!;
        var chapter = await projects.CreateChapterAsync("Chapter");
        var scene = await projects.CreateSceneAsync(chapter.Guid, "Scene");
        await projects.WriteSceneContentAsync(chapter, scene, "<p>First draft</p>");
        var reference = new SceneRef(book.Id, book.ActiveDraftId!, chapter.Guid, scene.Id);
        await projects.CreateDraftAsync("Second");
        await projects.SwitchDraftAsync(book.Drafts.Last().Id);
        var activeDraft = book.ActiveDraftId;
        _ = workspace.ExtensionsHost;
        var opened = 0;
        workspace.HostServices!.SceneOpened += _ => opened++;
        var result = await new ScenesRpc(workspace).ReadPassiveAsync(reference.BookId, reference.DraftId,
            reference.ChapterGuid, reference.SceneId);
        Assert.Equal("<p>First draft</p>", result.Html);
        Assert.Equal(ContentHasher.Hash(result.Html), result.Hash);
        Assert.Equal(activeDraft, book.ActiveDraftId);
        Assert.Equal(0, opened);
    }

    [Fact]
    public async Task ReaderRejectsUnknownContextAndDoesNotReconcileIdentityMismatch()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        await workspace.Projects.CreateProjectAsync(directory.Path, "Novel", "Book");
        var projects = workspace.Projects;
        var chapter = await projects.CreateChapterAsync("Chapter");
        var scene = await projects.CreateSceneAsync(chapter.Guid, "Scene");
        var reference = new SceneRef(projects.ActiveBook!.Id, projects.ActiveBook.ActiveDraftId!, chapter.Guid, scene.Id);
        var reader = new SceneDocumentReader(projects, workspace.FileService);
        await Assert.ThrowsAsync<InvalidOperationException>(() => reader.ReadAsync(reference with { DraftId = "missing" }));
        await workspace.FileService.WriteTextAsync(projects.GetSceneFilePath(chapter, scene), FileFrontMatter.Stamp("<p>Other</p>", "other"));
        await Assert.ThrowsAsync<IOException>(() => reader.ReadAsync(reference));
        Assert.Equal(scene.Id, projects.GetScenesForChapter(chapter.Guid).Single().Id);
        scene.FileName = Path.Combine("..", "..", "..", "..", "..", "outside.html");
        await Assert.ThrowsAsync<InvalidDataException>(() => reader.ReadAsync(reference));
    }
}
