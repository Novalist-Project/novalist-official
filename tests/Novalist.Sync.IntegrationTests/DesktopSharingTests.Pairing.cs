using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Novalist.Backend;
using Novalist.Backend.Rpc;
using Novalist.Core.Services;
using Novalist.Sync.Client;
using Novalist.Sync.Client.Tests;
using Novalist.Sync.Server.Data;
using Novalist.Sync.Server.Hubs;
using StreamJsonRpc;
using Xunit;

namespace Novalist.Sync.IntegrationTests;

public sealed partial class DesktopSharingTests
{
    [Fact]
    public async Task AnActiveDeviceApprovesPairingButRevokedDevicesCannotApproveNewKeys()
    {
        var ct = TestContext.Current.CancellationToken;
        var folder = Path.Combine(Path.GetTempPath(), "novalist-pairing-desktop", Guid.NewGuid().ToString("N"));
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
            await project.CreateProjectAsync(Path.Combine(folder, "project"), "Pairing project", "Book");
            await using var original = new DesktopParticipant(Path.Combine(folder, "original"), issuer);
            await original.Rpc.InvokeWithParameterObjectAsync("project/open", new { path = project.ProjectRoot }, ct);
            await original.Rpc.InvokeWithParameterObjectAsync("collaboration/account/signIn", new { server = server.Address }, ct);
            await original.Rpc.InvokeWithParameterObjectAsync("collaboration/account/enrollDevice", new { server = server.Address }, ct);
            await original.Rpc.InvokeWithParameterObjectAsync<HostedSessionDto>("collaboration/persistent/create", new { server = server.Address }, ct);
            await using var incoming = new DesktopParticipant(Path.Combine(folder, "incoming"), issuer);
            await incoming.Rpc.InvokeWithParameterObjectAsync("collaboration/account/signIn", new { server = server.Address }, ct);
            var request = await incoming.Rpc.InvokeWithParameterObjectAsync<DevicePairingRequest>(
                "collaboration/account/createDevicePairing", new { server = server.Address, deviceName = "Second laptop" }, ct);
            await Assert.ThrowsAsync<RemoteInvocationException>(() => incoming.Rpc.InvokeWithParameterObjectAsync<HostedAccountDto>(
                "collaboration/account/completeDevicePairing", new { server = server.Address }, ct));
            var preview = await original.Rpc.InvokeWithParameterObjectAsync<DevicePairingRequest>(
                "collaboration/account/reviewDevicePairing", new { server = server.Address, request = request.Request }, ct);
            Assert.Equal(request.Fingerprint, preview.Fingerprint);
            await original.Rpc.InvokeWithParameterObjectAsync("collaboration/account/approveDevicePairing", new { server = server.Address, request = preview.Request }, ct);
            var completed = await incoming.Rpc.InvokeWithParameterObjectAsync<HostedAccountDto>(
                "collaboration/account/completeDevicePairing", new { server = server.Address }, ct);
            Assert.True(completed.DeviceRegistered);
            Assert.False(completed.HasRecoveryToken);
            await original.Rpc.InvokeAsync("collaboration/end");
            await using var scope = server.Services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<SyncDbContext>();
            var root = await db.Devices.SingleAsync(device => device.LinkedByDeviceId == null, ct);
            Assert.Equal(2, await db.Devices.CountAsync(device => device.LinkedByDeviceId == root.Id, ct));
            await scope.ServiceProvider.GetRequiredService<AccessRevocation>().RevokeDeviceAsync(root.UserId, root.Id, ct);
            await using var third = new DesktopParticipant(Path.Combine(folder, "third"), issuer);
            await third.Rpc.InvokeWithParameterObjectAsync("collaboration/account/signIn", new { server = server.Address }, ct);
            var next = await third.Rpc.InvokeWithParameterObjectAsync<DevicePairingRequest>(
                "collaboration/account/createDevicePairing", new { server = server.Address, deviceName = "Third laptop" }, ct);
            await Assert.ThrowsAsync<RemoteInvocationException>(() => original.Rpc.InvokeWithParameterObjectAsync<bool>(
                "collaboration/account/approveDevicePairing", new { server = server.Address, request = next.Request }, ct));
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }
}
