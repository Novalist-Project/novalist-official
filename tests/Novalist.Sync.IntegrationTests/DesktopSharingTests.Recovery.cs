using System.Security.Cryptography;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Novalist.Backend.Rpc;
using Novalist.Sync.Client;
using Novalist.Sync.Client.Tests;
using Novalist.Sync.Server.Data;
using StreamJsonRpc;
using Xunit;

namespace Novalist.Sync.IntegrationTests;

public sealed partial class DesktopSharingTests
{
    [Fact]
    public async Task ASavedRecoveryTokenRegistersAReplacementWithTheSameServerIdentity()
    {
        var ct = TestContext.Current.CancellationToken;
        var folder = Path.Combine(Path.GetTempPath(), "novalist-recovery-desktop", Guid.NewGuid().ToString("N"));
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
            string token;
            await using (var original = new DesktopParticipant(Path.Combine(folder, "original"), issuer))
            {
                await original.Rpc.InvokeWithParameterObjectAsync("collaboration/account/signIn", new { server = server.Address }, ct);
                var account = await original.Rpc.InvokeWithParameterObjectAsync<HostedAccountDto>(
                    "collaboration/account/enrollDevice", new { server = server.Address }, ct);
                var path = Path.Combine(folder, "token.txt");
                await original.Rpc.InvokeWithParameterObjectAsync("collaboration/account/saveRecoveryToken", new { server = server.Address, outputPath = path }, ct);
                token = (await File.ReadAllTextAsync(path, ct)).Trim();
                Assert.Equal(account.RecoveryToken, token);
            }
            await using var replacement = new DesktopParticipant(Path.Combine(folder, "replacement"), issuer);
            await replacement.Rpc.InvokeWithParameterObjectAsync("collaboration/account/signIn", new { server = server.Address }, ct);
            var before = issuer.Authorizations;
            await Assert.ThrowsAsync<RemoteInvocationException>(() => replacement.Rpc.InvokeWithParameterObjectAsync<HostedAccountDto>(
                "collaboration/account/recoverDevice", new { server = server.Address, recoveryToken = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)) }, ct));
            var recovered = await replacement.Rpc.InvokeWithParameterObjectAsync<HostedAccountDto>(
                "collaboration/account/recoverDevice", new { server = server.Address, recoveryToken = token }, ct);
            Assert.True(recovered.DeviceRegistered);
            Assert.Equal(before, issuer.Authorizations);
            using var recovery = RecoveryDeviceIdentity.Derive(Convert.FromBase64String(token));
            await using var scope = server.Services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<SyncDbContext>();
            var backup = await db.Devices.SingleAsync(device => device.Id == recovery.Id, ct);
            var linked = await db.Devices.SingleAsync(device => device.LinkedByDeviceId == recovery.Id, ct);
            Assert.Equal(backup.UserId, linked.UserId);
        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }
}
