using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed class WritingStructureRpcTests
{
    [Fact]
    public async Task RpcCreatesPreviewsAndRestoresStructureWithExplicitEpoch()
    {
        using var dir = new TempDir();
        using var workspace = new Workspace(dir.Path);
        await workspace.Projects.CreateProjectAsync(dir.Path, "Project", "Book");
        var book = workspace.Projects.ActiveBook!;
        var rpc = new WritingRpc(workspace);
        var request = new StructureRequest("insert", 0, book.Id, book.ActiveDraftId, new InsertChapterCommand("Chapter", null, null));
        Assert.Equal("retryable", (await rpc.StructureAsync(request with { ExpectedEpoch = 1 })).Status);
        Assert.Equal("retryable", (await rpc.StructureAsync(request with { Command = new InsertChapterCommand("", null, null) })).Status);
        var result = await rpc.StructureAsync(request);
        Assert.Equal("committed", result.Status);
        Assert.NotNull(result.FocusScene);
        Assert.Single(result.State!.Chapters);
        Assert.NotEmpty(rpc.PreviewRegroup(book.Id, book.ActiveDraftId, 0).RevisionToken);
        Assert.Throws<InvalidOperationException>(() => rpc.PreviewRegroup(book.Id, "wrong", 0));
        Assert.Empty((await rpc.UndoStructureAsync(result.OperationId!, 0)).State!.Chapters);
        Assert.Single((await rpc.RedoStructureAsync(result.OperationId!, 0)).State!.Chapters);
        var scene = result.FocusScene!;
        var split = new SplitSceneCommand(scene, "", "New", "Old", ContentHasher.Hash("Old"));
        Assert.Equal("conflict", (await rpc.StructureAsync(request with { TransactionId = "split", Command = split })).Status);
    }
}
