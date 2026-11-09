using System.Text;
using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Core.Services;
using Novalist.Sync.Client;
using Novalist.Sync.Client.Tests;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed class PersistentProjectCompactionTests
{
    [Fact]
    public async Task AWriterCompactsAndAnOfflineWriterResumesFromTheNewestCheckpoint()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        var (project, chapter, scene) = await CreateProjectAsync(temp.Path);
        await using var owner = new HostedDesktop(Path.Combine(temp.Path, "owner"), identity);
        await owner.Rpc.InvokeAsync("project/open", project.ProjectRoot);
        await owner.SignInAsync(server.Address);
        var hosted = await owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/create", server.Address);
        var link = await owner.Rpc.InvokeAsync<string>("collaboration/invite", DateTimeOffset.UtcNow.AddHours(1));
        await using var writer = await SignInAsAsync(temp.Path, identity, server, "writer");
        var joined = await writer.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/join", server.Address, link, Path.Combine(temp.Path, "Writer"));
        await using var away = await SignInAsAsync(temp.Path, identity, server, "away");
        await away.Rpc.InvokeAsync("collaboration/persistent/join", server.Address,
            await owner.Rpc.InvokeAsync<string>("collaboration/invite", DateTimeOffset.UtcNow.AddHours(1)), Path.Combine(temp.Path, "Away"));
        await away.Rpc.InvokeAsync("collaboration/end");
        var document = await owner.Rpc.InvokeAsync<SceneContentDto>("scenes/read", chapter.Guid, scene.Id);
        await owner.Rpc.InvokeAsync("collaboration/writeScene", hosted.SessionId, document.Shared!.ItemId, Encoding.UTF8.GetBytes("<p>Written while away.</p>"));
        await owner.Host.Workspace.HostedProjects!.FlushAsync();
        await WaitForAsync(async () => (await writer.Rpc.InvokeAsync<SceneContentDto>("scenes/read", chapter.Guid, scene.Id)).Html == "<p>Written while away.</p>");

        var compactor = writer.Host.Workspace.HostedProjects!;
        compactor.CompactionDue = (_, _) => true;
        Assert.True(await compactor.CompactIfDueAsync(ct));

        Assert.Equal(1, server.Compactions);
        Assert.Equal(joined.SessionId, (await writer.Rpc.InvokeAsync<HostedSessionDto>("collaboration/status")).SessionId);
        var boundary = writer.Host.Workspace.HostedProjects!.AdoptedCheckpointStart;
        Assert.NotNull(boundary);
        // The owner learns of the compaction from the server and invites from the newest checkpoint.
        await WaitForAsync(async () =>
        {
            await owner.Rpc.InvokeAsync<string>("collaboration/invite", DateTimeOffset.UtcNow.AddHours(1));
            return owner.Host.Workspace.HostedProjects!.AdoptedCheckpointStart == boundary;
        });
        await using (var invitee = await SignInAsAsync(temp.Path, identity, server, "late"))
        {
            var late = await owner.Rpc.InvokeAsync<string>("collaboration/invite", DateTimeOffset.UtcNow.AddHours(1));
            await invitee.Rpc.InvokeAsync("collaboration/persistent/join", server.Address, late, Path.Combine(temp.Path, "Late"));
            Assert.Equal("<p>Written while away.</p>", (await invitee.Rpc.InvokeAsync<SceneContentDto>("scenes/read", chapter.Guid, scene.Id)).Html);
        }
        var resumed = await away.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/resume");
        Assert.Equal("<p>Written while away.</p>", (await away.Rpc.InvokeAsync<SceneContentDto>("scenes/read", chapter.Guid, scene.Id)).Html);
        await away.Rpc.InvokeAsync("collaboration/end");
        Assert.Equal(resumed.SessionId, (await away.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/resume")).SessionId);
        await away.Rpc.InvokeAsync("collaboration/end");
    }

    [Fact]
    public async Task AnInvitationFromBeforeACompactionStillJoinsTheCurrentProject()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        var (project, chapter, scene) = await CreateProjectAsync(temp.Path);
        await using var owner = new HostedDesktop(Path.Combine(temp.Path, "owner"), identity);
        await owner.Rpc.InvokeAsync("project/open", project.ProjectRoot);
        await owner.SignInAsync(server.Address);
        var hosted = await owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/create", server.Address);
        var early = await owner.Rpc.InvokeAsync<string>("collaboration/invite", DateTimeOffset.UtcNow.AddHours(1));
        var document = await owner.Rpc.InvokeAsync<SceneContentDto>("scenes/read", chapter.Guid, scene.Id);
        await owner.Rpc.InvokeAsync("collaboration/writeScene", hosted.SessionId, document.Shared!.ItemId, Encoding.UTF8.GetBytes("<p>After the invitation.</p>"));
        await owner.Host.Workspace.HostedProjects!.FlushAsync();
        var compactor = owner.Host.Workspace.HostedProjects!;
        compactor.CompactionDue = (_, _) => true;
        Assert.True(await compactor.CompactIfDueAsync(ct));

        await using var guest = await SignInAsAsync(temp.Path, identity, server, "guest");
        var joined = await guest.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/join", server.Address, early, Path.Combine(temp.Path, "Guest"));

        Assert.Equal(hosted.ProjectId, joined.ProjectId);
        Assert.Equal("<p>After the invitation.</p>", (await guest.Rpc.InvokeAsync<SceneContentDto>("scenes/read", chapter.Guid, scene.Id)).Html);
    }

    [Fact]
    public async Task CompactionStaysOffWhenItIsNotDueUnsafeOrUnsupported()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        var (project, chapter, scene) = await CreateProjectAsync(temp.Path);
        await using var owner = new HostedDesktop(Path.Combine(temp.Path, "owner"), identity);
        await owner.Rpc.InvokeAsync("project/open", project.ProjectRoot);
        await owner.SignInAsync(server.Address);
        var workspace = owner.Host.Workspace.HostedProjects!;
        Assert.False(await workspace.CompactIfDueAsync(ct));
        var hosted = await owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/create", server.Address);

        Assert.False(await workspace.CompactIfDueAsync(ct));
        workspace.CompactionDue = (_, _) => true;
        server.Reject = "compact";
        Assert.False(await workspace.CompactIfDueAsync(ct));
        server.Reject = "commitCompaction";
        Assert.False(await workspace.CompactIfDueAsync(ct));
        server.Reject = null;
        server.ReservedSequenceShift = 1;
        Assert.False(await workspace.CompactIfDueAsync(ct));
        server.ReservedSequenceShift = 0;
        server.Reject = "push";
        var document = await owner.Rpc.InvokeAsync<SceneContentDto>("scenes/read", chapter.Guid, scene.Id);
        await owner.Rpc.InvokeAsync("collaboration/writeScene", hosted.SessionId, document.Shared!.ItemId, Encoding.UTF8.GetBytes("<p>Not sent yet.</p>"));
        Assert.True((await owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/status")).HasPendingUpdates);
        Assert.False(await workspace.CompactIfDueAsync(ct));
        await owner.Rpc.InvokeAsync("collaboration/end");
        server.Reject = null;

        // A server from before history compaction: resuming still works, and compaction stays off for the session.
        server.HistoryUnsupported = true;
        var resumed = await owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/resume");
        Assert.Equal(hosted.SessionId, resumed.SessionId);
        await WaitForAsync(async () => (await owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/status")) is { Connection: "Connected", HasPendingUpdates: false });
        Assert.False(await workspace.CompactIfDueAsync(ct));
        server.HistoryUnsupported = false;
        Assert.False(await workspace.CompactIfDueAsync(ct));
        Assert.Equal(0, server.Compactions);
    }

    [Fact]
    public async Task TheBackgroundCheckCompactsWhileTheSessionRunsAndStopsWithIt()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        var (project, _, _) = await CreateProjectAsync(temp.Path);
        await using var owner = new HostedDesktop(Path.Combine(temp.Path, "owner"), identity);
        await owner.Rpc.InvokeAsync("project/open", project.ProjectRoot);
        await owner.SignInAsync(server.Address);
        var workspace = owner.Host.Workspace.HostedProjects!;
        workspace.CompactionCheckInterval = TimeSpan.FromMilliseconds(20);
        workspace.CompactionCheckJitter = TimeSpan.Zero;
        var due = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        workspace.CompactionDue = (_, _) => { due.TrySetResult(); return false; };

        await owner.Rpc.InvokeAsync("collaboration/persistent/create", server.Address);
        await due.Task.WaitAsync(TimeSpan.FromSeconds(10), ct);
        workspace.CompactionDue = (_, _) => true;
        await WaitForAsync(() => Task.FromResult(server.Compactions > 0));
        await owner.Rpc.InvokeAsync("collaboration/end");
        var settled = server.Compactions;
        await Task.Delay(200, ct);

        Assert.Equal(settled, server.Compactions);
    }

    private static async Task<(ProjectService Project, Core.Models.ChapterData Chapter, Core.Models.SceneData Scene)> CreateProjectAsync(string root)
    {
        var project = new ProjectService(new FileService());
        await project.CreateProjectAsync(root, "Novel", "Book");
        var chapter = await project.CreateChapterAsync("Opening");
        var scene = await project.CreateSceneAsync(chapter.Guid, "Arrival");
        return (project, chapter, scene);
    }

    private static async Task<HostedDesktop> SignInAsAsync(string root, TestIdentityProvider identity, PersistentSessionServer server, string subject)
    {
        identity.Subject = subject;
        identity.IssueAccessToken = () => subject + "-token";
        var desktop = new HostedDesktop(Path.Combine(root, subject), identity);
        await desktop.SignInAsync(server.Address);
        return desktop;
    }

    private static async Task WaitForAsync(Func<Task<bool>> condition)
    {
        for (var attempt = 0; attempt < 100; attempt++)
        {
            if (await condition()) return;
            await Task.Delay(100);
        }
        Assert.Fail("The condition was not met in time.");
    }
}
