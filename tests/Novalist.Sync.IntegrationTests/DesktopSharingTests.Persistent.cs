using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Novalist.Backend;
using Novalist.Backend.Rpc;
using Novalist.Core.Services;
using Novalist.Sync.Client;
using Novalist.Sync.Client.Tests;
using StreamJsonRpc;
using Xunit;

namespace Novalist.Sync.IntegrationTests;

public sealed partial class DesktopSharingTests
{
    [Fact]
    public async Task PersistentDesktopJoinsAndResumesWithOwnerOfflineAndRetainsLocalDifferences()
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(60));
        var ct = deadline.Token;
        var folder = Path.Combine(Path.GetTempPath(), "novalist-persistent-desktop", Guid.NewGuid().ToString("N"));
        await using var issuer = await TestIdentityProvider.StartAsync(ct);
        await using var server = new CommunityServerFixture(issuer);
        await server.InitializeAsync();
        issuer.IssueAccessToken = () => server.Token(issuer.Subject);
        issuer.MultiFactorAuthentication = true;
        server.Services.GetRequiredService<IOptionsMonitor<JwtBearerOptions>>()
            .Get(JwtBearerDefaults.AuthenticationScheme).Authority = issuer.Authority.AbsoluteUri;
        server.Services.GetRequiredService<IConfiguration>()["Authentication:NativeClient:Scope"] = "openid profile sync offline_access";
        try
        {
            var project = new ProjectService(new FileService());
            await project.CreateProjectAsync(folder, "Persistent novel", "Book");
            var chapter = await project.CreateChapterAsync("Opening");
            var scene = await project.CreateSceneAsync(chapter.Guid, "Arrival");
            await project.WriteSceneContentAsync(chapter, scene, "<p>Original writing.</p>");
            await using var owner = new DesktopParticipant(Path.Combine(folder, "owner-settings"), issuer);
            await owner.Rpc.InvokeWithParameterObjectAsync("project/open", new { path = project.ProjectRoot }, ct);
            await owner.Rpc.InvokeWithParameterObjectAsync("collaboration/account/signIn", new { server = server.Address }, ct);
            await owner.Rpc.InvokeWithParameterObjectAsync("collaboration/account/enrollDevice", new { server = server.Address }, ct);
            Assert.Equal("0", issuer.RequestedMaxAge);
            var hosted = await owner.Rpc.InvokeWithParameterObjectAsync<HostedSessionDto>("collaboration/persistent/create", new { server = server.Address }, ct);
            Assert.Equal("persistent", hosted.Mode);
            var ownerRead = await owner.Rpc.InvokeWithParameterObjectAsync<SceneContentDto>("scenes/read", new { chapterGuid = chapter.Guid, sceneId = scene.Id }, ct);
            await owner.Rpc.InvokeWithParameterObjectAsync("collaboration/writeScene", new { sessionId = hosted.SessionId,
                itemId = ownerRead.Shared!.ItemId, update = Encoding.UTF8.GetBytes("<p>Stored owner update.</p>") }, ct);
            var link = await owner.Rpc.InvokeWithParameterObjectAsync<string>("collaboration/invite", new { expiresAt = DateTimeOffset.UtcNow.AddHours(1) }, ct);
            await Assert.ThrowsAsync<RemoteInvocationException>(() => owner.Rpc.InvokeWithParameterObjectAsync("collaboration/account/signOut", new { server = server.Address }, ct));
            await owner.Rpc.InvokeAsync("collaboration/end");

            issuer.Subject = "guest";
            await using var guest = new DesktopParticipant(Path.Combine(folder, "guest-settings"), issuer);
            await guest.Rpc.InvokeWithParameterObjectAsync("collaboration/account/signIn", new { server = server.Address }, ct);
            await guest.Rpc.InvokeWithParameterObjectAsync("collaboration/account/enrollDevice", new { server = server.Address }, ct);
            var destination = Path.Combine(folder, "Joined novel");
            var joined = await guest.Rpc.InvokeWithParameterObjectAsync<HostedSessionDto>("collaboration/persistent/join", new { server = server.Address, link, destination }, ct);
            var read = await guest.Rpc.InvokeWithParameterObjectAsync<SceneContentDto>("scenes/read", new { chapterGuid = chapter.Guid, sceneId = scene.Id }, ct);
            Assert.Equal("<p>Stored owner update.</p>", read.Html);
            Assert.Equal("persistent", joined.Mode);
            Assert.False(joined.IsOwner);
            await guest.Rpc.InvokeWithParameterObjectAsync("collaboration/writeScene", new { sessionId = joined.SessionId,
                itemId = read.Shared!.ItemId, update = Encoding.UTF8.GetBytes("<p>Guest writing while owner is offline.</p>") }, ct);
            await guest.Rpc.InvokeAsync("collaboration/end");

            await File.WriteAllTextAsync(project.GetSceneFilePath(chapter, scene),
                Novalist.Core.Models.FileFrontMatter.Stamp("<p>Local unshared difference.</p>", scene.Id), ct);
            var resumed = await owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/resume");
            Assert.Equal(hosted.ProjectId, resumed.ProjectId);
            Assert.NotNull(resumed.RecoveryPath);
            Assert.True(File.Exists(resumed.RecoveryPath));
            Assert.Equal("persistent", (await owner.Rpc.InvokeAsync<SavedHostedProjectDto>("collaboration/saved")).Mode);
            var caughtUp = await owner.Rpc.InvokeWithParameterObjectAsync<SceneContentDto>("scenes/read", new { chapterGuid = chapter.Guid, sceneId = scene.Id }, ct);
            Assert.Equal("<p>Guest writing while owner is offline.</p>", caughtUp.Html);
            await guest.Rpc.InvokeAsync("collaboration/persistent/resume");
            await guest.Rpc.InvokeAsync("collaboration/end");
            var members = await owner.Rpc.InvokeAsync<HostedProjectMember[]>("collaboration/members");
            var contributor = Assert.Single(members, member => member.Role == "Contributor");
            await owner.Rpc.InvokeWithParameterObjectAsync("collaboration/removeMember", new { memberId = contributor.UserId }, ct);
            Assert.Single(await owner.Rpc.InvokeAsync<HostedProjectMember[]>("collaboration/members"));
            await Assert.ThrowsAsync<RemoteInvocationException>(() => guest.Rpc.InvokeAsync("collaboration/persistent/resume"));
            await owner.Rpc.InvokeAsync("collaboration/deleteSharedProject");
            Assert.Null(await owner.Rpc.InvokeAsync<HostedSessionDto?>("collaboration/status"));
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }
}
