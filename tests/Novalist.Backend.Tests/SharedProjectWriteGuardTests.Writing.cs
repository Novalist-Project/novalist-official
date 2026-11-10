using Novalist.Backend.Rpc;
using Novalist.Core.Models;
using Novalist.Core.Services;
using System.Text;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed partial class SharedProjectWriteGuardTests
{
    [Fact]
    public async Task PartialSharedProjectionRetainsBatchAndPublishesOnlyAfterRetry()
    {
        var files = new InterruptedStructureFiles();
        await using var fixture = await SharedProjectFixture.StartAsync(files);
        var projects = fixture.Host.Workspace.Projects;
        var book = projects.ActiveBook!;
        var request = new StructureRequest("interrupted", 0, book.Id, book.ActiveDraftId, new InsertChapterCommand("New chapter", null, null));
        files.WritesRemaining = 1;
        Assert.Equal("retryable", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/structure", request)).Status);
        Assert.Single(fixture.Host.Workspace.BuildState().Chapters);
        files.WritesRemaining = null;
        var result = await fixture.Desktop.InvokeAsync<StructureResult>("writing/structure", request);
        Assert.Equal("committed", result.Status);
        Assert.Equal(2, result.State!.Chapters.Count);
        Assert.Equal("committed", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/structure", request)).Status);
    }

    private sealed class InterruptedStructureFiles : FileService, IFileService
    {
        internal int? WritesRemaining { get; set; }
        internal string? RejectedText { get; set; }
        Task IFileService.WriteBytesAsync(string path, byte[] content)
        {
            if (WritesRemaining == 0) throw new IOException("Injected shared projection failure.");
            if (WritesRemaining is not null) WritesRemaining--;
            return WriteBytesAsync(path, content);
        }
        Task IFileService.WriteTextAsync(string path, string content)
        {
            if (RejectedText is { } rejected && content.Contains(rejected, StringComparison.Ordinal)) throw new IOException("Injected collaborative document projection failure.");
            return WriteTextAsync(path, content);
        }
    }

    [Fact]
    public async Task AnnotationRequestsRequireTheExplicitSceneToHaveAnExistingSharedIdentity()
    {
        await using var fixture = await SharedProjectFixture.StartAsync(attach: false);
        await fixture.AttachAsync(fixture.State with { Documents = fixture.State.Documents.Where(document => document.TextField is not null).ToArray() });
        var projects = fixture.Host.Workspace.Projects;
        var book = projects.ActiveBook!;
        var chapter = Assert.Single(book.Chapters);
        var scene = Assert.Single(projects.GetScenesForChapter(chapter.Guid));
        var reference = new SceneRef(book.Id, book.ActiveDraftId, chapter.Guid, scene.Id);
        var annotations = WritingAnnotations.FromScene(scene);
        var result = await fixture.Desktop.InvokeAsync<WritingSharedAnnotationResult>("writing/commitSharedAnnotations", new WritingSharedAnnotationRequest("unshared", 0, [new(reference, annotations, annotations)]));
        Assert.Equal("retryable", result.Status);
    }

    [Fact]
    public async Task SharedActRenameUpdatesLeasedReferencesAndCanUndo()
    {
        await using var fixture = await SharedProjectFixture.StartAsync(attach: false);
        var projects = fixture.Host.Workspace.Projects;
        var book = projects.ActiveBook!;
        book.Acts = [new() { Name = "Act" }];
        book.Chapters[0].Act = "Act";
        var entityService = new EntityService(projects);
        var character = Assert.Single(await entityService.LoadCharactersAsync());
        character.StateOverrides = [new() { Id = "reference", Act = "Act" }];
        await entityService.SaveCharacterAsync(character);
        await projects.SaveProjectAsync();
        await fixture.CaptureAsync();
        await fixture.AttachAsync(fixture.State);
        var request = new StructureRequest("rename", 0, book.Id, book.ActiveDraftId, new RenameActCommand("Act", "Renamed"));
        var renamed = await fixture.Desktop.InvokeAsync<StructureResult>("writing/structure", request);
        Assert.Equal("committed", renamed.Status);
        Assert.Equal("Renamed", Assert.Single((await entityService.LoadCharactersAsync())[0].StateOverrides).Act);
        Assert.Equal("committed", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/undoStructure", renamed.OperationId, 0)).Status);
        Assert.Equal("Act", Assert.Single((await entityService.LoadCharactersAsync())[0].StateOverrides).Act);
    }

    [Fact]
    public async Task SharedStructureCreatesMovesAndRestoresBindingsUnderOneReceipt()
    {
        await using var fixture = await SharedProjectFixture.StartAsync();
        var workspace = fixture.Host.Workspace;
        var book = workspace.Projects.ActiveBook!;
        var chapter = Assert.Single(book.Chapters);
        var scene = Assert.Single(workspace.Projects.GetScenesForChapter(chapter.Guid));
        var request = new StructureRequest("insert", 0, book.Id, book.ActiveDraftId, new InsertChapterCommand("New", null, null));
        var inserted = await fixture.Desktop.InvokeAsync<StructureResult>("writing/structure", request);
        Assert.Equal("committed", inserted.Status);
        Assert.Equal(2, inserted.State!.Chapters.Count);
        Assert.Equal("committed", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/structure", request)).Status);
        Assert.Equal("committed", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/undoStructure", inserted.OperationId, 0)).Status);
        Assert.Equal("committed", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/undoStructure", inserted.OperationId, 0)).Status);
        Assert.Equal("committed", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/redoStructure", inserted.OperationId, 0)).Status);
        var move = request with { TransactionId = "move", Command = new MoveScenesCommand([scene.Id], inserted.FocusScene!.ChapterGuid, inserted.FocusScene.SceneId) };
        var moved = await fixture.Desktop.InvokeAsync<StructureResult>("writing/structure", move);
        Assert.Equal("committed", moved.Status);
        Assert.Empty(moved.State!.Chapters.Single(c => c.Guid == chapter.Guid).Scenes);
        var active = workspace.Projects.ActiveBook!;
        active.ActiveDraftId = "different";
        Assert.Equal("retryable", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/undoStructure", moved.OperationId, 0)).Status);
        active.ActiveDraftId = book.ActiveDraftId;
        await fixture.Desktop.InvokeAsync("collaboration/writeScene", fixture.SessionId, fixture.Scene.ItemId, Encoding.UTF8.GetBytes("html:<p>Peer text follows the moved scene.</p>"));
        var undone = await fixture.Desktop.InvokeAsync<StructureResult>("writing/undoStructure", moved.OperationId, 0);
        Assert.Equal("committed", undone.Status);
        Assert.Single(undone.State!.Chapters.Single(c => c.Guid == chapter.Guid).Scenes);
        var restored = workspace.ResolveScene(chapter.Guid, scene.Id);
        Assert.Equal("<p>Peer text follows the moved scene.</p>", await workspace.Projects.ReadSceneContentAsync(restored.chapter, restored.scene));
        Assert.Equal("committed", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/redoStructure", moved.OperationId, 0)).Status);
        var movedRef = new SceneRef(book.Id, book.ActiveDraftId, inserted.FocusScene.ChapterGuid, scene.Id);
        var before = WritingAnnotations.FromScene(workspace.ResolveScene(movedRef.ChapterGuid, movedRef.SceneId).scene);
        var after = before with { Comments = [new("peer", "", "Peer annotation", false)] };
        Assert.Equal("committed", (await fixture.Desktop.InvokeAsync<WritingSharedAnnotationResult>("writing/commitSharedAnnotations",
            new WritingSharedAnnotationRequest("peer-after-move", 0, [new(movedRef, before, after)]))).Status);
        Assert.Equal("conflict", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/undoStructure", moved.OperationId, 0)).Status);
    }

    [Fact]
    public async Task SharedSplitPublishesPreparedSourceDeltaAndRejectsUndoAfterChildEdit()
    {
        var files = new InterruptedStructureFiles();
        await using var fixture = await SharedProjectFixture.StartAsync(files);
        var workspace = fixture.Host.Workspace;
        var book = workspace.Projects.ActiveBook!;
        var chapter = Assert.Single(book.Chapters);
        var scene = Assert.Single(workspace.Projects.GetScenesForChapter(chapter.Guid));
        var reference = new SceneRef(book.Id, book.ActiveDraftId, chapter.Guid, scene.Id);
        var shared = fixture.Scene;
        var prepared = new SharedSplitPreparation(fixture.SessionId, shared.ItemId, shared.State, Encoding.UTF8.GetBytes("html:<p>Original</p>"),
            Guid.NewGuid(), Encoding.UTF8.GetBytes("html:<p> prose.</p>"), shared.State);
        var command = new SplitSceneCommand(reference, "<p>Original</p>", "<p> prose.</p>", "<p>Original prose.</p>", ContentHasher.Hash("<p>Original prose.</p>")) { SharedSplit = prepared };
        var request = new StructureRequest("split", 0, book.Id, book.ActiveDraftId, command);
        files.RejectedText = "<p>Original</p>";
        Assert.Equal("retryable", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/structure", request)).Status);
        Assert.Single(Assert.Single(workspace.BuildState().Chapters).Scenes);
        files.RejectedText = null;
        var result = await fixture.Desktop.InvokeAsync<StructureResult>("writing/structure", request);
        Assert.Equal("committed", result.Status);
        Assert.Equal(2, Assert.Single(result.State!.Chapters).Scenes.Count);
        var source = await workspace.RequireSharedScenes(fixture.SessionId).ReadAsync(shared.ItemId, TestContext.Current.CancellationToken);
        Assert.Equal("<p>Original</p>", source.Html);
        var inverse = new SharedStructureInverse(fixture.SessionId, shared.ItemId, source.State, shared.State);
        Assert.Equal("retryable", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/undoStructure", result.OperationId, 0)).Status);
        Assert.Equal("committed", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/undoStructure", result.OperationId, 0, inverse)).Status);
        var replacement = Guid.NewGuid();
        var redo = new SharedStructureInverse(fixture.SessionId, shared.ItemId, shared.State, prepared.RetainedUpdate, replacement, prepared.CreatedState);
        Assert.Equal("retryable", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/redoStructure", result.OperationId, 0, redo with { CreatedItemId = null })).Status);
        Assert.Equal("committed", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/redoStructure", result.OperationId, 0, redo)).Status);
        await fixture.Desktop.InvokeAsync("collaboration/writeScene", fixture.SessionId, prepared.CreatedItemId, Encoding.UTF8.GetBytes("html:<p>Old binding recovered.</p>"));
        Assert.Contains(Directory.GetFiles(Path.Combine(fixture.Root, "Recovered edits"), "*.novalist", SearchOption.AllDirectories), path => File.ReadAllText(path).Contains("Old binding recovered."));
        await fixture.Desktop.InvokeAsync("collaboration/writeScene", fixture.SessionId, replacement, Encoding.UTF8.GetBytes("html:<p>Peer child edit.</p>"));
        var undone = await fixture.Desktop.InvokeAsync<StructureResult>("writing/undoStructure", result.OperationId, 0, inverse);
        Assert.Equal("conflict", undone.Status);
        var child = await workspace.RequireSharedScenes(fixture.SessionId).ReadAsync(replacement, TestContext.Current.CancellationToken);
        Assert.Equal("<p>Peer child edit.</p>", child.Html);
    }

    [Fact]
    public async Task RecreatedSharedChildCanSplitAndRecoverProjectionWithRetiredBindingAtSamePath()
    {
        var files = new InterruptedStructureFiles();
        await using var fixture = await SharedProjectFixture.StartAsync(files);
        var workspace = fixture.Host.Workspace;
        var book = workspace.Projects.ActiveBook!;
        var chapter = Assert.Single(book.Chapters);
        var scene = Assert.Single(workspace.Projects.GetScenesForChapter(chapter.Guid));
        var reference = new SceneRef(book.Id, book.ActiveDraftId, chapter.Guid, scene.Id);
        var shared = fixture.Scene;
        var prepared = new SharedSplitPreparation(fixture.SessionId, shared.ItemId, shared.State, Encoding.UTF8.GetBytes("html:<p>Original</p>"),
            Guid.NewGuid(), Encoding.UTF8.GetBytes("html:<p> prose.</p>"), shared.State);
        var command = new SplitSceneCommand(reference, "<p>Original</p>", "<p> prose.</p>", "<p>Original prose.</p>", ContentHasher.Hash("<p>Original prose.</p>")) { SharedSplit = prepared };
        var split = await fixture.Desktop.InvokeAsync<StructureResult>("writing/structure", new StructureRequest("first-split", 0, book.Id, book.ActiveDraftId, command));
        Assert.Equal("committed", split.Status);
        var inverse = new SharedStructureInverse(fixture.SessionId, shared.ItemId, prepared.RetainedUpdate, shared.State);
        Assert.Equal("committed", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/undoStructure", split.OperationId, 0, inverse)).Status);
        var replacement = Guid.NewGuid();
        var redo = new SharedStructureInverse(fixture.SessionId, shared.ItemId, shared.State, prepared.RetainedUpdate, replacement, prepared.CreatedState);
        Assert.Equal("committed", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/redoStructure", split.OperationId, 0, redo)).Status);
        const string childHtml = "<p>Child two words.</p>";
        await fixture.Desktop.InvokeAsync("collaboration/writeScene", fixture.SessionId, replacement, Encoding.UTF8.GetBytes("html:" + childHtml));
        var child = await workspace.RequireSharedScenes(fixture.SessionId).ReadAsync(replacement, TestContext.Current.CancellationToken);
        var childPreparation = new SharedSplitPreparation(fixture.SessionId, replacement, child.State, Encoding.UTF8.GetBytes("html:<p>Child</p>"),
            Guid.NewGuid(), Encoding.UTF8.GetBytes("html:<p> two words.</p>"), child.State);
        var childCommand = new SplitSceneCommand(split.FocusScene!, "<p>Child</p>", "<p> two words.</p>", childHtml, ContentHasher.Hash(childHtml)) { SharedSplit = childPreparation };
        var request = new StructureRequest("split-recreated-child", 0, book.Id, book.ActiveDraftId, childCommand);
        files.RejectedText = "<p>Child</p>";
        Assert.Equal("retryable", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/structure", request)).Status);
        Assert.Equal(2, Assert.Single(workspace.BuildState().Chapters).Scenes.Count);
        files.RejectedText = null;
        var completed = await fixture.Desktop.InvokeAsync<StructureResult>("writing/structure", request);
        Assert.Equal("committed", completed.Status);
        var scenes = Assert.Single(completed.State!.Chapters).Scenes;
        Assert.Equal(3, scenes.Count);
        Assert.Equal(1, scenes.Single(item => item.Id == split.FocusScene!.SceneId).WordCount);
        Assert.Equal(2, scenes.Single(item => item.Id == completed.FocusScene!.SceneId).WordCount);
        Assert.Equal(completed.FocusScene, (await fixture.Desktop.InvokeAsync<StructureResult>("writing/structure", request)).FocusScene);
        await fixture.Desktop.InvokeAsync("collaboration/writeScene", fixture.SessionId, prepared.CreatedItemId, Encoding.UTF8.GetBytes("html:<p>Late retired child.</p>"));
        Assert.Contains(Directory.GetFiles(Path.Combine(fixture.Root, "Recovered edits"), "*.novalist", SearchOption.AllDirectories), path => File.ReadAllText(path).Contains("Late retired child."));
        Assert.Equal("<p>Child</p>", (await workspace.RequireSharedScenes(fixture.SessionId).ReadAsync(replacement, TestContext.Current.CancellationToken)).Html);
        var next = request with { TransactionId = "after-replayed-child-split", Command = new CreateActCommand("Next act", null) };
        Assert.Equal("committed", (await fixture.Desktop.InvokeAsync<StructureResult>("writing/structure", next)).Status);
    }

    [Fact]
    public async Task SharedAnnotationCommitReplaysAndUndoKeepsPeerAddedRecords()
    {
        await using var fixture = await SharedProjectFixture.StartAsync();
        var workspace = fixture.Host.Workspace;
        var book = workspace.Projects.ActiveBook!;
        var chapter = Assert.Single(book.Chapters);
        var scene = Assert.Single(workspace.Projects.GetScenesForChapter(chapter.Guid));
        var reference = new SceneRef(book.Id, book.ActiveDraftId, chapter.Guid, scene.Id);
        var before = WritingAnnotations.FromScene(scene);
        var after = before with { Comments = [new("local", "", "Local note", false) { CreatedAt = DateTime.UnixEpoch, Author = "Writer" }] };
        var request = new WritingSharedAnnotationRequest("local", 0, [new(reference, before, after)]);
        Assert.Equal("retryable", (await fixture.Desktop.InvokeAsync<WritingSharedAnnotationResult>("writing/commitSharedAnnotations", request with { Changes = [] })).Status);
        Assert.Equal("retryable", (await fixture.Desktop.InvokeAsync<WritingSharedAnnotationResult>("writing/commitSharedAnnotations", request with { ExpectedEpoch = 1 })).Status);
        var result = await fixture.Desktop.InvokeAsync<WritingSharedAnnotationResult>("writing/commitSharedAnnotations", request);
        Assert.Equal("committed", result.Status);
        Assert.Equal(result.OperationId, (await fixture.Desktop.InvokeAsync<WritingSharedAnnotationResult>("writing/commitSharedAnnotations", request)).OperationId);
        var own = Assert.Single(result.Annotations!).Annotations;
        var peer = own with { Comments = [.. own.Comments, new("peer", "", "Peer note", false)] };
        Assert.Equal("committed", (await fixture.Desktop.InvokeAsync<WritingSharedAnnotationResult>("writing/commitSharedAnnotations",
            new WritingSharedAnnotationRequest("peer", 0, [new(reference, own, peer)]))).Status);
        var undone = await fixture.Desktop.InvokeAsync<WritingSharedAnnotationResult>("writing/commitSharedAnnotations",
            new WritingSharedAnnotationRequest("undo", 0, [new(reference, after, before)]));
        Assert.Equal("committed", undone.Status);
        Assert.Equal("peer", Assert.Single(Assert.Single(undone.Annotations!).Annotations.Comments).Id);
        var changed = after with { Comments = [after.Comments[0] with { Text = "Late update" }] };
        Assert.Equal("conflict", (await fixture.Desktop.InvokeAsync<WritingSharedAnnotationResult>("writing/commitSharedAnnotations",
            new WritingSharedAnnotationRequest("conflict", 0, [new(reference, after, changed)]))).Status);
    }
}
