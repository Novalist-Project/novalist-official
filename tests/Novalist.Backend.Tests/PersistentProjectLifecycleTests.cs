using System.Text;
using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Core.Services;
using Novalist.Sync.Client;
using Novalist.Sync.Client.Tests;
using StreamJsonRpc;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed class PersistentProjectLifecycleTests
{
    [Fact]
    public async Task RetainedProjectsOfferTheMostRecentlyUsedServerMode()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var persistent = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var relay = await HostedSessionServer.StartAsync(identity.Authority, ct);
        await using var desktop = new HostedDesktop(Path.Combine(temp.Path, "settings"), identity);
        var project = new ProjectService(new FileService());
        await project.CreateProjectAsync(temp.Path, "Novel", "Book");
        await desktop.Rpc.InvokeAsync("project/open", project.ProjectRoot);
        await desktop.SignInAsync(persistent.Address);
        await desktop.Rpc.InvokeAsync("collaboration/persistent/create", persistent.Address);
        await desktop.Rpc.InvokeAsync("collaboration/end");
        await using var host = new HostedDesktop(Path.Combine(temp.Path, "host"), identity);
        await host.Rpc.InvokeAsync("project/open", project.ProjectRoot);
        await host.SignInAsync(relay.Address);
        await host.Rpc.InvokeAsync("collaboration/create", relay.Address);
        var invitation = await host.Rpc.InvokeAsync<string>("collaboration/invite", DateTimeOffset.UtcNow.AddHours(1));
        await desktop.SignInAsync(relay.Address);
        await desktop.Rpc.InvokeAsync("collaboration/join", relay.Address, invitation, project.ProjectRoot);
        await desktop.Rpc.InvokeAsync("collaboration/end");
        Assert.Equal("hosted", (await desktop.Rpc.InvokeAsync<SavedHostedProjectDto>("collaboration/saved")).Mode);
        await host.Rpc.InvokeAsync("collaboration/end");
        await desktop.Rpc.InvokeAsync("collaboration/persistent/resume");
        await desktop.Rpc.InvokeAsync("collaboration/end");
        Assert.Equal("persistent", (await desktop.Rpc.InvokeAsync<SavedHostedProjectDto>("collaboration/saved")).Mode);
    }

    [Fact]
    public async Task ServerProjectsKeepTheirIdentityAcrossDisconnectsAndPublishAccessChanges()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var owner = new HostedDesktop(Path.Combine(temp.Path, "owner"), identity);
        var project = new ProjectService(new FileService());
        await project.CreateProjectAsync(temp.Path, "Novel", "Book");
        var chapter = await project.CreateChapterAsync("Opening");
        var scene = await project.CreateSceneAsync(chapter.Guid, "Arrival");
        await owner.Rpc.InvokeAsync("project/open", project.ProjectRoot);
        await owner.SignInAsync(server.Address);
        identity.MultiFactorAuthentication = true;
        await owner.Rpc.InvokeAsync("collaboration/account/enrollDevice", server.Address);
        await owner.Rpc.InvokeAsync("collaboration/account/enrollDevice", server.Address);
        Assert.Single(owner.Credentials.Keys, key => key.StartsWith("recovery-device:", StringComparison.Ordinal));
        Assert.Null(await owner.Rpc.InvokeAsync<HostedSessionDto?>("collaboration/status"));
        var hosted = await owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/create", server.Address);
        Assert.Equal("persistent", hosted.Mode);
        var document = await owner.Rpc.InvokeAsync<SceneContentDto>("scenes/read", chapter.Guid, scene.Id);
        await owner.Rpc.InvokeAsync("collaboration/presence", hosted.SessionId, document.Shared!.ItemId, Guid.NewGuid(), null, true);
        Assert.NotNull(await owner.Rpc.InvokeAsync<object>("collaboration/participants", hosted.SessionId));
        await owner.Rpc.InvokeAsync("collaboration/writeScene", hosted.SessionId, document.Shared.ItemId, Encoding.UTF8.GetBytes("<p>Owner update.</p>"));
        var link = await owner.Rpc.InvokeAsync<string>("collaboration/invite", DateTimeOffset.UtcNow.AddHours(1));
        await owner.Rpc.InvokeAsync("collaboration/end");
        identity.Subject = "guest";
        identity.IssueAccessToken = () => "guest-token";
        await using var guest = new HostedDesktop(Path.Combine(temp.Path, "guest"), identity);
        await guest.SignInAsync(server.Address);
        var destination = Path.Combine(temp.Path, "Joined");
        var joined = await guest.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/join", server.Address, link, destination);
        Assert.Equal(hosted.ProjectId, joined.ProjectId);
        Assert.False(joined.IsOwner);
        await Assert.ThrowsAsync<RemoteInvocationException>(() => guest.Rpc.InvokeAsync("collaboration/members"));
        await guest.Rpc.InvokeAsync("collaboration/presence", joined.SessionId, document.Shared.ItemId, Guid.NewGuid(), null, true);
        var notify = guest.Host.Workspace.Coordinator!.Notify!;
        guest.Host.Workspace.Coordinator.Notify = (method, payload) => method == "ui/showNotification"
            ? Task.FromException(new IOException("Notification pipe is unavailable.")) : notify(method, payload);
        server.Reject = "push";
        await guest.Rpc.InvokeAsync("collaboration/writeScene", joined.SessionId, document.Shared.ItemId, Encoding.UTF8.GetBytes("<p>Queued writer update.</p>"));
        await guest.Rpc.InvokeAsync("collaboration/end");
        server.Reject = null;
        var resumed = await owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/resume");
        Assert.Equal(hosted.SessionId, resumed.SessionId);
        Assert.Equal("persistent", (await owner.Rpc.InvokeAsync<SavedHostedProjectDto>("collaboration/saved")).Mode);
        var writerId = Assert.Single(await owner.Rpc.InvokeAsync<HostedProjectMember[]>("collaboration/members"), member => member.Role == "Contributor").UserId;
        var thirdLink = await owner.Rpc.InvokeAsync<string>("collaboration/invite", DateTimeOffset.UtcNow.AddHours(1));
        identity.Subject = "removed";
        identity.IssueAccessToken = () => "removed-token";
        await using var removed = new HostedDesktop(Path.Combine(temp.Path, "removed"), identity);
        await removed.SignInAsync(server.Address);
        await removed.Rpc.InvokeAsync("collaboration/persistent/join", server.Address, thirdLink, Path.Combine(temp.Path, "Third"));
        await removed.Rpc.InvokeAsync("collaboration/end");
        var members = await owner.Rpc.InvokeAsync<HostedProjectMember[]>("collaboration/members");
        var removedId = Assert.Single(members, member => member.Role == "Contributor" && member.UserId != writerId).UserId;
        owner.Documents.BeforeCapture = () => throw new IOException("Checkpoint capture failed.");
        await Assert.ThrowsAsync<RemoteInvocationException>(() => owner.Rpc.InvokeAsync("collaboration/removeMember", removedId));
        owner.Documents.BeforeCapture = null;
        await owner.Rpc.InvokeAsync("collaboration/removeMember", removedId);
        Assert.Equal(2, (await owner.Rpc.InvokeAsync<HostedProjectMember[]>("collaboration/members")).Length);
        guest.Documents.RejectNextLoad = true;
        await Assert.ThrowsAsync<RemoteInvocationException>(() => guest.Rpc.InvokeAsync("collaboration/persistent/resume"));
        var refreshed = await guest.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/resume");
        Assert.NotEqual(joined.SessionId, refreshed.SessionId);
        Assert.Equal("<p>Queued writer update.</p>", (await guest.Rpc.InvokeAsync<SceneContentDto>("scenes/read", chapter.Guid, scene.Id)).Html);
        await guest.Rpc.InvokeAsync("collaboration/end");
        await owner.Rpc.InvokeAsync("collaboration/deleteSharedProject");
        Assert.Null(await owner.Rpc.InvokeAsync<HostedSessionDto?>("collaboration/status"));
        Assert.True(File.Exists(project.GetSceneFilePath(chapter, scene)));
    }

    [Theory]
    [InlineData("create")]
    [InlineData("push")]
    [InlineData("join")]
    public async Task FailedCreationLeavesTheLocalProjectUsableAndTheOperationRetryable(string failure)
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var desktop = new HostedDesktop(Path.Combine(temp.Path, "settings"), identity);
        var project = new ProjectService(new FileService());
        await project.CreateProjectAsync(temp.Path, "Novel", "Book");
        await desktop.Rpc.InvokeAsync("project/open", project.ProjectRoot);
        await desktop.SignInAsync(server.Address);
        server.Reject = failure;
        await Assert.ThrowsAsync<RemoteInvocationException>(() => desktop.Rpc.InvokeAsync("collaboration/persistent/create", server.Address));
        Assert.Null(await desktop.Rpc.InvokeAsync<HostedSessionDto?>("collaboration/status"));
        server.Reject = null;
        await desktop.Rpc.InvokeAsync("collaboration/persistent/create", server.Address);
        await desktop.Rpc.InvokeAsync("collaboration/end");
    }

    [Fact]
    public async Task CancelAndShutdownStopPersistentPreparationWithoutBlockingTheWorkspace()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        var desktop = new HostedDesktop(Path.Combine(temp.Path, "settings"), identity);
        try
        {
            var project = new ProjectService(new FileService());
            await project.CreateProjectAsync(temp.Path, "Novel", "Book");
            await desktop.Rpc.InvokeAsync("project/open", project.ProjectRoot);
            await desktop.SignInAsync(server.Address);
            server.Connecting = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var creating = desktop.Rpc.InvokeAsync("collaboration/persistent/create", server.Address);
            await server.Connecting.Task.WaitAsync(TimeSpan.FromSeconds(5), ct);
            await Assert.ThrowsAsync<InvalidOperationException>(() => desktop.Host.Workspace.HostedProjects!.CreateAsync(server.Address, ct));
            await desktop.Rpc.InvokeAsync("collaboration/cancel");
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => creating).WaitAsync(TimeSpan.FromSeconds(5), ct);
            server.Connecting = new(TaskCreationOptions.RunContinuationsAsynchronously);
            creating = desktop.Rpc.InvokeAsync("collaboration/persistent/create", server.Address);
            await server.Connecting.Task.WaitAsync(TimeSpan.FromSeconds(5), ct);
            await desktop.Host.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5), ct);
            await Assert.ThrowsAnyAsync<Exception>(() => creating);
        }
        finally { desktop.Rpc.Dispose(); }
    }
}
