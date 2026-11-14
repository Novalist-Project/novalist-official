using Novalist.Backend.Rpc;
using Novalist.Core.Models;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed partial class SharedProjectWriteGuardTests
{
    [Fact]
    public async Task DiskRefreshAndConflictResolutionLeaveSharedProseOnItsExistingChannel()
    {
        await using var fixture = await SharedProjectFixture.StartAsync();
        var projects = fixture.Host.Workspace.Projects;
        var book = projects.ActiveBook!;
        var chapter = Assert.Single(book.Chapters);
        var scene = Assert.Single(projects.GetScenesForChapter(chapter.Guid));
        var reference = new SceneRef(book.Id, book.ActiveDraftId!, chapter.Guid, scene.Id);
        var refresh = await fixture.Desktop.InvokeAsync<SceneRefreshDto>("scenes/refresh", new object[] { Array.Empty<SceneVersionDto>() });
        Assert.Empty(refresh.Counts);
        Assert.Empty(refresh.Changes);
        var request = new WritingConflictResolution("shared-conflict", 0, reference, "stale", "mine", "chosen", "theirs");
        var result = await fixture.Desktop.InvokeAsync<WritingCommitResult>("writing/resolveConflict", request);
        Assert.Equal("retryable", result.Status);
    }
}
