using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Nerdbank.Streams;
using Novalist.Backend;
using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Core.Services;
using Novalist.Sync.Client;
using Novalist.Sync.Client.Tests;
using StreamJsonRpc;
using Xunit;

namespace Novalist.Sync.IntegrationTests;

public sealed partial class DesktopSharingTests
{
    [Theory]
    [InlineData("external")]
    [InlineData("capture")]
    [InlineData("join")]
    public async Task InterruptedSharingPreservesExternalWritingAndCanBeCancelledByShutdown(string interruption)
    {
        var ct = TestContext.Current.CancellationToken;
        var folder = Path.Combine(Path.GetTempPath(), "novalist-desktop-sharing", Guid.NewGuid().ToString("N"));
        await using var server = new RelayServerFixture();
        await using var issuer = await TestIdentityProvider.StartAsync(ct);
        issuer.Subject = "owner-" + Guid.NewGuid();
        issuer.IssueAccessToken = () => server.Token(issuer.Subject);
        ConfigureDesktopSignIn(server, issuer.Authority);
        DesktopParticipant? owner = null;
        DesktopParticipant? guest = null;
        Task? creating = null;
        var unblockCapture = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        try
        {
            var project = new ProjectService(new FileService());
            await project.CreateProjectAsync(folder, "Shared novel", "Book");
            var chapter = await project.CreateChapterAsync("Opening");
            var scene = await project.CreateSceneAsync(chapter.Guid, "Arrival");
            await project.WriteSceneContentAsync(chapter, scene, "<p>Original writing.</p>");
            owner = new DesktopParticipant(Path.Combine(folder, "owner-settings"), issuer);
            await owner.Rpc.InvokeWithParameterObjectAsync("project/open", new { path = project.ProjectRoot }, ct);
            await owner.Rpc.InvokeWithParameterObjectAsync("collaboration/account/signIn", new { server = server.Address }, ct);
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            Task WaitForCapture(CancellationToken token) => entered.TrySetResult() ? unblockCapture.Task.WaitAsync(token) : Task.CompletedTask;
            if (interruption == "capture") owner.Documents.BeforeCapture = WaitForCapture;
            else if (interruption == "external") owner.Documents.OnClose = () => File.WriteAllText(project.GetSceneFilePath(chapter, scene),
                Novalist.Core.Models.FileFrontMatter.Stamp("<p>External writing during upload.</p>", scene.Id));
            creating = owner.Rpc.InvokeWithParameterObjectAsync("collaboration/create", new { server = server.Address }, ct);
            if (interruption == "join")
            {
                await creating;
                var link = await owner.Rpc.InvokeWithParameterObjectAsync<string>("collaboration/invite",
                    new { expiresAt = DateTimeOffset.UtcNow.AddHours(1) }, ct);
                issuer.Subject = "guest-" + Guid.NewGuid();
                guest = new DesktopParticipant(Path.Combine(folder, "guest-settings"), issuer);
                await guest.Rpc.InvokeWithParameterObjectAsync("collaboration/account/signIn", new { server = server.Address }, ct);
                owner.Documents.BeforeCapture = WaitForCapture;
                creating = guest.Rpc.InvokeWithParameterObjectAsync("collaboration/join",
                    new { server = server.Address, link, destination = Path.Combine(folder, "Joined novel") }, ct);
            }
            if (interruption != "external")
            {
                await entered.Task.WaitAsync(TimeSpan.FromSeconds(5), ct);
                await owner.Rpc.InvokeAsync("system/shutdown");
                await owner.DisposeAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5), ct);
                owner = null;
                await Assert.ThrowsAnyAsync<Exception>(() => creating).WaitAsync(TimeSpan.FromSeconds(5), ct);
            }
            else
            {
                await Assert.ThrowsAsync<RemoteInvocationException>(() => creating);
                Assert.Equal("<p>External writing during upload.</p>", await project.ReadSceneContentAsync(chapter, scene));
                Assert.Null(await owner.Rpc.InvokeAsync<HostedSessionDto?>("collaboration/status"));
            }
        }
        finally
        {
            if (owner is not null)
            {
                unblockCapture.TrySetResult();
                if (creating is not null) await creating.ContinueWith(_ => { }, TaskScheduler.Default);
                await owner.DisposeAsync();
            }
            if (guest is not null) await guest.DisposeAsync();
            if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true);
        }
    }

    [Fact]
    public async Task DesktopGuestKeepsAUsableLocalProjectWhenTheLiveHostEnds()
    {
        var ct = TestContext.Current.CancellationToken;
        var folder = Path.Combine(Path.GetTempPath(), "novalist-desktop-sharing", Guid.NewGuid().ToString("N"));
        await using var server = new RelayServerFixture();
        await using var issuer = await TestIdentityProvider.StartAsync(ct);
        issuer.Subject = "owner-" + Guid.NewGuid();
        issuer.IssueAccessToken = () => server.Token(issuer.Subject);
        ConfigureDesktopSignIn(server, issuer.Authority);
        try
        {
            var project = new ProjectService(new FileService());
            await project.CreateProjectAsync(folder, "Shared novel", "Book");
            var chapter = await project.CreateChapterAsync("Opening");
            var scene = await project.CreateSceneAsync(chapter.Guid, "Arrival");
            await project.WriteSceneContentAsync(chapter, scene, "<p>Original writing.</p>");
            await using var owner = new DesktopParticipant(Path.Combine(folder, "owner-settings"), issuer);
            await owner.Rpc.InvokeWithParameterObjectAsync("project/open", new { path = project.ProjectRoot }, ct);
            await owner.Rpc.InvokeWithParameterObjectAsync("collaboration/account/signIn", new { server = server.Address }, ct);

            var sharing = await owner.Rpc.InvokeWithParameterObjectAsync<JsonElement>("collaboration/create", new { server = server.Address }, ct);
            var ownerRead = await owner.Rpc.InvokeWithParameterObjectAsync<SceneContentDto>("scenes/read", new { chapterGuid = chapter.Guid, sceneId = scene.Id }, ct);
            Assert.Equal(sharing.GetProperty("sessionId").GetGuid(), ownerRead.Shared!.SessionId);
            var link = await owner.Rpc.InvokeWithParameterObjectAsync<string>("collaboration/invite", new { expiresAt = DateTimeOffset.UtcNow.AddHours(1) }, ct);
            await Assert.ThrowsAsync<RemoteInvocationException>(() => owner.Rpc.InvokeWithParameterObjectAsync(
                "collaboration/account/signOut", new { server = server.Address }, ct));
            issuer.Subject = "guest-" + Guid.NewGuid();
            await using var guest = new DesktopParticipant(Path.Combine(folder, "guest-settings"), issuer);
            await guest.Rpc.InvokeWithParameterObjectAsync("collaboration/account/signIn", new { server = server.Address }, ct);
            var destination = Path.Combine(folder, "Joined novel");
            var joined = await guest.Rpc.InvokeWithParameterObjectAsync<JsonElement>("collaboration/join", new { server = server.Address, link, destination }, ct);
            var read = await guest.Rpc.InvokeWithParameterObjectAsync<SceneContentDto>("scenes/read", new { chapterGuid = chapter.Guid, sceneId = scene.Id }, ct);
            Assert.Equal("<p>Original writing.</p>", read.Html);
            Assert.Equal(ownerRead.Shared.ItemId, read.Shared!.ItemId);
            Assert.Equal(joined.GetProperty("sessionId").GetGuid(), read.Shared.SessionId);
            await guest.Rpc.InvokeWithParameterObjectAsync("collaboration/writeScene",
                new { sessionId = read.Shared.SessionId, itemId = read.Shared.ItemId, update = Encoding.UTF8.GetBytes("<p>Guest writing.</p>") }, ct);
            await guest.Rpc.InvokeAsync("collaboration/end");
            await owner.Rpc.InvokeAsync("collaboration/end");
            await Assert.ThrowsAsync<RemoteInvocationException>(() => guest.Rpc.InvokeWithParameterObjectAsync(
                "collaboration/join", new { server = server.Address, link, destination }, ct));
            var retained = new ProjectService(new FileService());
            await retained.LoadProjectAsync(destination);
            Assert.Equal("<p>Guest writing.</p>", await retained.ReadSceneContentAsync(chapter, scene));
            Assert.Null((await guest.Rpc.InvokeWithParameterObjectAsync<SceneContentDto>("scenes/read", new { chapterGuid = chapter.Guid, sceneId = scene.Id }, ct)).Shared);
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true); }
    }

    private static void ConfigureDesktopSignIn(RelayServerFixture server, Uri authority)
    {
        server.Services.GetRequiredService<IOptionsMonitor<JwtBearerOptions>>()
            .Get(JwtBearerDefaults.AuthenticationScheme).Authority = authority.AbsoluteUri;
        var configuration = server.Services.GetRequiredService<IConfiguration>();
        configuration["Authentication:NativeClient:ClientId"] = "novalist";
        configuration["Authentication:NativeClient:Scope"] = "openid profile sync offline_access";
    }

    private sealed class DesktopParticipant : IAsyncDisposable
    {
        private readonly BackendHost host;
        public JsonRpc Rpc { get; }
        public CollaborationDocumentPeer Documents { get; } = new();
        internal HostedProjectWorkspace Persistent => host.Workspace.HostedProjects!;

        public DesktopParticipant(string settings, TestIdentityProvider issuer)
        {
            host = new(settings);
            var (backend, desktop) = FullDuplexStream.CreatePair();
            host.Attach(backend, backend);
            var formatter = new SystemTextJsonFormatter();
            formatter.JsonSerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
            Rpc = new(new HeaderDelimitedMessageHandler(desktop, desktop, formatter));
            Rpc.AddLocalRpcTarget(new DesktopPeer(issuer));
            Rpc.AddLocalRpcTarget(Documents);
            Rpc.StartListening();
        }

        public async ValueTask DisposeAsync() { await host.DisposeAsync(); Rpc.Dispose(); }
    }

    private sealed class DesktopPeer(TestIdentityProvider issuer)
    {
        private readonly Dictionary<string, string> credentials = [];

        [JsonRpcMethod("collaboration/openBrowser")]
        public Task OpenBrowserAsync(Uri url, CancellationToken cancellationToken) => issuer.OpenBrowserAsync(url, cancellationToken);

        [JsonRpcMethod("collaboration/credentials")]
        public string? Credentials(string action, string key, string? value = null)
        {
            if (action == "read") return credentials.GetValueOrDefault(key);
            if (action == "write") credentials[key] = value ?? throw new ArgumentException("Missing credential.");
            else if (action == "remove") credentials.Remove(key);
            else throw new ArgumentException("Unknown credential operation.");
            return null;
        }

    }
}
