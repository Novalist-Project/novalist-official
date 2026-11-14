using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Xunit;
using SceneChange = Novalist.Core.Models.SceneChange;

namespace Novalist.Backend.Tests;

public sealed class WritingRpcTests
{
    [Fact]
    public async Task CommittedRetryRepairsModelsAfterThePublicationReadFailed()
    {
        using var directory = new TempDir();
        var files = new FailingWritingFiles();
        using var workspace = new Workspace(directory.Path, fileService: files);
        var request = await SeedAsync(workspace, directory.Path);
        files.FailReload = true;
        var rpc = new WritingRpc(workspace);
        Assert.Equal("retryable", (await rpc.CommitAsync(request)).Status);
        Assert.Equal("committed", (await rpc.CommitAsync(request)).Status);
        Assert.Equal(2, workspace.BuildState().Chapters.Single().Scenes.Count);
    }

    [Fact]
    public async Task InvalidChangesAndStaleExpectedHashCannotMutateFiles()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var request = await SeedAsync(workspace, directory.Path);
        var rpc = new WritingRpc(workspace);
        Assert.Equal("retryable", (await rpc.CommitAsync(request with { Changes = [] })).Status);
        Assert.Equal("retryable", (await rpc.CommitAsync(request with { Changes = [request.Changes[0], request.Changes[0]] })).Status);
        Assert.Equal("conflict", (await rpc.CommitAsync(request with { Changes = [request.Changes[0] with { ExpectedHash = "old" }] })).Status);
        var reference = request.Changes[0].Ref;
        var duplicate = new WritingAnnotations([new("same", "", "", false), new("same", "", "", false)], []);
        Assert.Equal("retryable", (await rpc.CommitAsync(request with { AnnotationChanges = [new(reference, new([], []), duplicate)] })).Status);
        var (chapter, scene) = workspace.ResolveScene(reference.ChapterGuid, reference.SceneId);
        await workspace.FileService.WriteTextAsync(workspace.Projects.GetSceneFilePath(chapter, scene), FileFrontMatter.Stamp("Changed", "other"));
        Assert.Equal("retryable", (await rpc.CommitAsync(request)).Status);
    }

    [Fact]
    public async Task SceneProjectionIncludesCastAndDeclaredPointOfView()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var request = await SeedAsync(workspace, directory.Path);
        var reference = request.Changes[0].Ref;
        var scene = workspace.ResolveScene(reference.ChapterGuid, reference.SceneId).scene;
        scene.Cast = ["character"];
        scene.AnalysisOverrides = new() { Pov = "Character" };
        var projected = workspace.BuildState().Chapters.Single().Scenes.First();
        Assert.Equal(["character"], projected.Cast);
        Assert.Equal("Character", projected.Pov);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(6)]
    public async Task FailureAtEveryJournalWriteRetainsEditsForRetry(int failAt)
    {
        using var directory = new TempDir();
        var files = new FailingWritingFiles();
        using var workspace = new Workspace(directory.Path, fileService: files);
        var request = await SeedAsync(workspace, directory.Path);
        var original = Directory.GetFiles(workspace.Projects.ProjectRoot!, "*", SearchOption.AllDirectories)
            .ToDictionary(path => path, File.ReadAllText);
        files.FailAt = failAt;
        var result = await new WritingRpc(workspace).CommitAsync(request);
        Assert.Equal("retryable", result.Status);
        foreach (var (path, content) in original) Assert.Equal(content, await File.ReadAllTextAsync(path));
        var retry = await new WritingRpc(workspace).CommitAsync(request);
        Assert.Equal("committed", retry.Status);
        Assert.Equal(result.OperationId, retry.OperationId);
    }

    [Fact]
    public async Task AnnotationCommitPreservesAuthorAndRepliesAndDetectsStaleMetadata()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var request = await SeedAsync(workspace, directory.Path);
        var reference = request.Changes[0].Ref;
        var scene = workspace.ResolveScene(reference.ChapterGuid, reference.SceneId).scene;
        scene.Comments = [new SceneComment { Id = "comment", AnchorText = "Before", Text = "Note", Author = "Original",
            Replies = [new() { Id = "reply", Author = "Reviewer", Text = "Reply" }] }];
        await workspace.Projects.SaveScenesAsync();
        var before = WritingAnnotations.FromScene(scene);
        var after = new WritingAnnotations([new("comment", "After", "Changed", true)], [new("footnote", 1, "Text")]);
        request = request with { AnnotationChanges = [new(reference, before, after)] };
        var result = await new WritingRpc(workspace).CommitAsync(request);
        Assert.Equal("committed", result.Status);
        scene = workspace.ResolveScene(reference.ChapterGuid, reference.SceneId).scene;
        Assert.Equal("Original", Assert.Single(scene.Comments!).Author);
        Assert.Equal("Changed", scene.Comments![0].Text);
        var passive = await new ScenesRpc(workspace).ReadPassiveAsync(reference.BookId, reference.DraftId, reference.ChapterGuid, reference.SceneId);
        var saved = Assert.Single(passive.Annotations!.Comments);
        Assert.Equal("After", saved.AnchorText);
        Assert.Equal("Changed", saved.Text);
        Assert.True(saved.Resolved);
        Assert.Equal("Original", saved.Author);
        Assert.Equal("Reply", Assert.Single(saved.Replies!).Text);
        Assert.Equal("conflict", (await new WritingRpc(workspace).CommitAsync(request with { TransactionId = "new", Changes = [] })).Status);
    }

    [Fact]
    public async Task DifferentBooksCommitWithoutChangingActiveBookOrEpoch()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var request = await SeedAsync(workspace, directory.Path);
        var other = await workspace.Projects.CreateBookAsync("Other");
        await workspace.Projects.SwitchBookAsync(other.Id);
        var chapter = await workspace.Projects.CreateChapterAsync("Other chapter");
        var scene = await workspace.Projects.CreateSceneAsync(chapter.Guid, "Other scene");
        request = request with { Changes = [.. request.Changes, new(new(other.Id, other.ActiveDraftId!, chapter.Guid, scene.Id), 0, "", "<p>Other text</p>")] };
        using var gate = new SemaphoreSlim(1, 1);
        workspace.Coordinator = new WorkspaceCoordinator(workspace, gate);
        workspace.Coordinator.Notify = (_, _) => throw new InvalidOperationException("Autosaves must not prepare every window.");
        workspace.Coordinator.Validate(new("1", 0, null), "writing/commit");
        Assert.Equal("committed", (await new WritingRpc(workspace).CommitAsync(request)).Status);
        Assert.Equal(other.Id, workspace.Projects.ActiveBook!.Id);
        Assert.Equal(0, workspace.Coordinator.Epoch);
    }

    [Fact]
    public async Task ConcurrentCommitsSerializeBeforeCheckingHashes()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var request = await SeedAsync(workspace, directory.Path);
        using var gate = new SemaphoreSlim(1, 1);
        workspace.Coordinator = new WorkspaceCoordinator(workspace, gate);
        var rpc = new WritingRpc(workspace);
        var results = await Task.WhenAll(rpc.CommitAsync(request), rpc.CommitAsync(request with { TransactionId = "other" }));
        Assert.Single(results, result => result.Status == "committed");
        Assert.Single(results, result => result.Status == "conflict");
    }

    [Fact]
    public async Task ProjectOpenRecoversInterruptedFilesBeforeLoadingSceneMetadata()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var request = await SeedAsync(workspace, directory.Path);
        var plan = await workspace.Projects.PlanWritingAsync(request);
        var root = workspace.Projects.ProjectRoot!;
        var journal = new WritingOperationJournal(root, workspace.FileService);
        await journal.PrepareAsync(request.TransactionId, "interrupted", plan.Files);
        await workspace.FileService.WriteTextAsync(plan.Files[0].Path, plan.Files[0].After!);
        using var restarted = new Workspace(directory.Path);
        await restarted.OpenProjectAsync(root);
        var original = await new SceneDocumentReader(restarted.Projects, restarted.FileService).ReadAsync(request.Changes[0].Ref);
        Assert.Equal(request.Changes[0].BeforeHtml, original.Html);
    }

    [Fact]
    public async Task CompoundCommitUpdatesBothScenesAndReplaysAfterRestart()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var request = await SeedAsync(workspace, directory.Path);
        var rpc = new WritingRpc(workspace);
        var result = await rpc.CommitAsync(request);
        Assert.Equal("committed", result.Status);
        Assert.Equal(2, result.Hashes!.Length);
        foreach (var change in request.Changes)
        {
            var read = await new SceneDocumentReader(workspace.Projects, workspace.FileService).ReadAsync(change.Ref);
            Assert.Equal(change.AfterHtml, read.Html);
            Assert.Equal(2, workspace.ResolveScene(change.Ref.ChapterGuid, change.Ref.SceneId).scene.WordCount);
        }
        using var reopened = new Workspace(directory.Path);
        await reopened.OpenProjectAsync(workspace.Projects.ProjectRoot!);
        var replay = await new WritingRpc(reopened).CommitAsync(request);
        Assert.Equal("committed", replay.Status);
        Assert.Equal(result.OperationId, replay.OperationId);
    }

    [Fact]
    public async Task StaleSecondSceneHashLeavesFirstSceneAndMetadataUntouched()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var request = await SeedAsync(workspace, directory.Path);
        var second = request.Changes[1].Ref;
        var (chapter, scene) = workspace.ResolveScene(second.ChapterGuid, second.SceneId);
        await workspace.Projects.WriteSceneContentAsync(chapter, scene, "<p>External</p>");
        var result = await new WritingRpc(workspace).CommitAsync(request);
        Assert.Equal("conflict", result.Status);
        Assert.Equal(second, Assert.Single(result.Conflicts!).Ref);
        var read = await new SceneDocumentReader(workspace.Projects, workspace.FileService).ReadAsync(request.Changes[0].Ref);
        Assert.Equal(request.Changes[0].BeforeHtml, read.Html);
    }

    [Fact]
    public async Task StaleEpochIsRetryableAndLeavesFilesUntouched()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var request = await SeedAsync(workspace, directory.Path);
        var result = await new WritingRpc(workspace).CommitAsync(request with { ExpectedEpoch = 1 });
        Assert.Equal("retryable", result.Status);
        Assert.Equal("writing.workspaceChanged", result.ErrorCode);
        var read = await new SceneDocumentReader(workspace.Projects, workspace.FileService).ReadAsync(request.Changes[0].Ref);
        Assert.Equal(request.Changes[0].BeforeHtml, read.Html);
    }

    private static async Task<WritingCommitRequest> SeedAsync(Workspace workspace, string root)
    {
        await workspace.Projects.CreateProjectAsync(root, "Novel", "Book");
        var book = workspace.Projects.ActiveBook!;
        var chapter = await workspace.Projects.CreateChapterAsync("Chapter");
        var changes = new List<SceneChange>();
        for (var index = 0; index < 2; index++)
        {
            var scene = await workspace.Projects.CreateSceneAsync(chapter.Guid, "Scene " + index);
            var before = "<p>Before " + index + "</p>";
            await workspace.Projects.WriteSceneContentAsync(chapter, scene, before);
            changes.Add(new(new(book.Id, book.ActiveDraftId!, chapter.Guid, scene.Id), 0, before, "<p>After " + index + "</p>"));
        }
        return new("transaction", 0, changes.ToArray(), []);
    }

    private sealed class FailingWritingFiles : FileService, IFileService
    {
        internal int FailAt { get; set; }
        internal bool FailReload { get; set; }
        private int _writes;

        Task<string> IFileService.ReadTextAsync(string path)
        {
            if (FailReload && path.EndsWith("draft.json", StringComparison.Ordinal))
            {
                FailReload = false;
                throw new IOException("Injected publication failure.");
            }
            return ReadTextAsync(path);
        }

        Task IFileService.WriteTextAsync(string path, string content)
        {
            if (FailAt > 0 && ++_writes == FailAt)
            {
                FailAt = 0;
                throw new IOException("Injected writing failure.");
            }
            return WriteTextAsync(path, content);
        }
    }
}
