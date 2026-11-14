using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed class WritingConflictResolutionTests
{
    [Fact]
    public async Task ResolutionKeepsBothVersionsInTheReferencedDraftWithoutActivatingIt()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var request = await SeedAsync(workspace, directory.Path);
        var counts = await new ScenesRpc(workspace).RefreshAsync([]);
        Assert.Equal(request.ExpectedDiskHash, Assert.Single(counts.Counts).Hash);
        var reader = new SceneDocumentReader(workspace.Projects, workspace.FileService);
        var resolved = await reader.ResolveAsync(request.Ref);
        var other = await workspace.Projects.CreateBookAsync("Other");
        await workspace.Projects.SwitchBookAsync(other.Id);
        var rpc = new WritingRpc(workspace);
        var result = await rpc.ResolveConflictAsync(request);
        Assert.Equal("committed", result.Status);
        Assert.Equal(request.Html, (await reader.ReadAsync(request.Ref)).Html);
        Assert.Equal(other.Id, workspace.Projects.ActiveBook!.Id);
        var snapshots = Directory.GetFiles(Path.Combine(resolved.DraftRoot, resolved.Book.SnapshotFolder), "*.json", SearchOption.AllDirectories)
            .Select(path => System.Text.Json.JsonSerializer.Deserialize<SceneSnapshot>(File.ReadAllText(path))!).ToArray();
        Assert.Contains(snapshots, snapshot => snapshot.Content == "<p>Disk version</p>" && snapshot.Label == "Before merge: version on disk");
        Assert.Contains(snapshots, snapshot => snapshot.Content == request.Mine && snapshot.Label == "Before merge: local version");
        Assert.Contains(snapshots, snapshot => snapshot.Content == request.Html && snapshot.Label == "After merge");
        Assert.Equal("committed", (await rpc.ResolveConflictAsync(request)).Status);
    }

    [Fact]
    public async Task ResolutionRejectsStaleDiskAndEpochWithoutWriting()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var request = await SeedAsync(workspace, directory.Path);
        using var gate = new SemaphoreSlim(1, 1);
        workspace.Coordinator = new WorkspaceCoordinator(workspace, gate);
        var rpc = new WritingRpc(workspace);
        Assert.Equal("retryable", (await rpc.ResolveConflictAsync(request with { ExpectedEpoch = 99 })).Status);
        Assert.Equal("conflict", (await rpc.ResolveConflictAsync(request with { ExpectedDiskHash = "stale" })).Status);
        var current = await new SceneDocumentReader(workspace.Projects, workspace.FileService).ReadAsync(request.Ref);
        Assert.Equal("<p>Disk version</p>", current.Html);
        Assert.Equal("committed", (await rpc.ResolveConflictAsync(request)).Status);
        Assert.Equal(0, workspace.Coordinator.Epoch);
    }

    private static async Task<WritingConflictResolution> SeedAsync(Workspace workspace, string path)
    {
        await workspace.Projects.CreateProjectAsync(path, "Novel", "Book");
        var chapter = await workspace.Projects.CreateChapterAsync("Chapter");
        var scene = await workspace.Projects.CreateSceneAsync(chapter.Guid, "Scene");
        await workspace.Projects.WriteSceneContentAsync(chapter, scene, "<p>Disk version</p>");
        var book = workspace.Projects.ActiveBook!;
        return new("resolution", 0, new(book.Id, book.ActiveDraftId!, chapter.Guid, scene.Id),
            ContentHasher.Hash("<p>Disk version</p>"), "<p>Local version</p>", "<p>Chosen version</p>", "<p>Disk version</p>");
    }

    [Fact]
    public async Task PassiveRefreshIdentifiesMissingCloudFilesWithoutActivation()
    {
        using var directory = new TempDir();
        using var workspace = new Workspace(directory.Path);
        var request = await SeedAsync(workspace, directory.Path);
        var document = await new SceneDocumentReader(workspace.Projects, workspace.FileService).ResolveAsync(request.Ref);
        File.Delete(document.Path);
        var content = await new ScenesRpc(workspace).ReadPassiveAsync(request.Ref.BookId, request.Ref.DraftId, request.Ref.ChapterGuid, request.Ref.SceneId);
        Assert.True(content.Missing);
        Assert.Empty(content.Html);
    }
}
