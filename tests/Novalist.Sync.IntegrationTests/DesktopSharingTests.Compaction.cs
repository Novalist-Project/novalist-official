using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Novalist.Backend;
using Novalist.Backend.Rpc;
using Novalist.Core.Services;
using Novalist.Sync.Client.Tests;
using Xunit;

namespace Novalist.Sync.IntegrationTests;

public sealed partial class DesktopSharingTests
{
    [Fact]
    public async Task AWriterCompactsTheServerHistoryAndTheOfflineOwnerResumesFromTheNewestCheckpoint()
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(60));
        var ct = deadline.Token;
        var folder = Path.Combine(Path.GetTempPath(), "novalist-compaction-desktop", Guid.NewGuid().ToString("N"));
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
            await project.CreateProjectAsync(folder, "Compacted novel", "Book");
            var chapter = await project.CreateChapterAsync("Opening");
            var scene = await project.CreateSceneAsync(chapter.Guid, "Arrival");
            await project.WriteSceneContentAsync(chapter, scene, "<p>Original writing.</p>");
            await using var owner = new DesktopParticipant(Path.Combine(folder, "owner-settings"), issuer);
            await owner.Rpc.InvokeWithParameterObjectAsync("project/open", new { path = project.ProjectRoot }, ct);
            await owner.Rpc.InvokeWithParameterObjectAsync("collaboration/account/signIn", new { server = server.Address }, ct);
            await owner.Rpc.InvokeWithParameterObjectAsync("collaboration/account/enrollDevice", new { server = server.Address }, ct);
            await owner.Rpc.InvokeWithParameterObjectAsync<HostedSessionDto>("collaboration/persistent/create", new { server = server.Address }, ct);
            var link = await owner.Rpc.InvokeWithParameterObjectAsync<string>("collaboration/invite", new { expiresAt = DateTimeOffset.UtcNow.AddHours(1) }, ct);
            await owner.Rpc.InvokeAsync("collaboration/end");

            issuer.Subject = "collaborator";
            await using var writer = new DesktopParticipant(Path.Combine(folder, "writer-settings"), issuer);
            await writer.Rpc.InvokeWithParameterObjectAsync("collaboration/account/signIn", new { server = server.Address }, ct);
            await writer.Rpc.InvokeWithParameterObjectAsync("collaboration/account/enrollDevice", new { server = server.Address }, ct);
            var joined = await writer.Rpc.InvokeWithParameterObjectAsync<HostedSessionDto>("collaboration/persistent/join",
                new { server = server.Address, link, destination = Path.Combine(folder, "Writer copy") }, ct);
            var read = await writer.Rpc.InvokeWithParameterObjectAsync<SceneContentDto>("scenes/read", new { chapterGuid = chapter.Guid, sceneId = scene.Id }, ct);
            await writer.Rpc.InvokeWithParameterObjectAsync("collaboration/writeScene", new { sessionId = joined.SessionId,
                itemId = read.Shared!.ItemId, update = Encoding.UTF8.GetBytes("<p>Written before the compaction.</p>") }, ct);
            await writer.Persistent.FlushAsync();
            writer.Persistent.CompactionDue = (_, _) => true;

            Assert.True(await writer.Persistent.CompactIfDueAsync(ct));
            await writer.Rpc.InvokeAsync("collaboration/end");

            var resumed = await owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/resume");
            var caughtUp = await owner.Rpc.InvokeWithParameterObjectAsync<SceneContentDto>("scenes/read", new { chapterGuid = chapter.Guid, sceneId = scene.Id }, ct);
            Assert.Equal("<p>Written before the compaction.</p>", caughtUp.Html);
            await owner.Rpc.InvokeAsync("collaboration/end");
            Assert.Equal(resumed.SessionId, (await owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/resume")).SessionId);
            await owner.Rpc.InvokeAsync("collaboration/end");
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }
}
