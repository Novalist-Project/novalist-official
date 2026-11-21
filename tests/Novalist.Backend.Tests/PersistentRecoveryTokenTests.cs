using System.Security.Cryptography;
using System.Text.Json;
using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Sync.Client;
using Novalist.Sync.Client.Tests;
using NSubstitute;
using StreamJsonRpc;
using Xunit;

namespace Novalist.Backend.Tests;

[Collection("BackendStatics")]
public sealed class PersistentRecoveryTokenTests
{
    [Fact]
    public async Task ExportWritesTheStoredTokenAndCanBeRepeatedAfterRestart()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        identity.MultiFactorAuthentication = true;
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        server.KeyBoundEnrollment = true;
        var credentials = new Dictionary<string, string>();
        var path = Path.Combine(temp.Path, "recovery.txt");
        string? token;
        await using (var desktop = new HostedDesktop(Path.Combine(temp.Path, "first"), identity, credentials))
        {
            var account = await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/signIn", server.Address);
            token = account.RecoveryToken;
            await desktop.Rpc.InvokeAsync("collaboration/account/saveRecoveryToken", server.Address, path);
            Assert.Equal(token, (await File.ReadAllTextAsync(path, ct)).Trim());
            await Assert.ThrowsAsync<RemoteInvocationException>(() => desktop.Rpc.InvokeAsync(
                "collaboration/account/saveRecoveryToken", server.Address, Path.Combine(temp.Path, "missing", "recovery.txt")));
            Assert.Equal(token, (await File.ReadAllTextAsync(path, ct)).Trim());
        }
        await using var restored = new HostedDesktop(Path.Combine(temp.Path, "second"), identity, credentials);
        await restored.Rpc.InvokeAsync("collaboration/account/saveRecoveryToken", server.Address, path);
        Assert.Equal(token, (await File.ReadAllTextAsync(path, ct)).Trim());
    }

    [Fact]
    public async Task RecoveryLinksFreshKeysAndPersistsThemWithoutResettingOrDeletingOldKeys()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        identity.MultiFactorAuthentication = true;
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var other = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        var credentials = new Dictionary<string, string>();
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        using var recovery = RecoveryDeviceIdentity.Derive(Convert.FromBase64String(token));
        await using (var desktop = new HostedDesktop(Path.Combine(temp.Path, "first"), identity, credentials))
        {
            await desktop.SignInAsync(server.Address);
            await desktop.SignInAsync(other.Address);
            await desktop.Rpc.InvokeAsync("collaboration/account/enrollDevice", other.Address);
            var old = Assert.Single(other.Registrations).Keys.DeviceId;
            var before = credentials.ToDictionary();
            var account = await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/recoverDevice", server.Address, token);
            Assert.True(account.DeviceRegistered);
            Assert.Null(account.RecoveryToken);
            var registration = Assert.Single(server.Registrations);
            Assert.Equal(recovery.Id, registration.LinkedByDeviceId);
            Assert.Equal(64, registration.LinkingSignature!.Length);
            Assert.NotEqual(old, registration.Keys.DeviceId);
            Assert.Equal(0, server.ResetCalls);
            foreach (var pair in before.Where(pair => pair.Key.StartsWith("device:", StringComparison.Ordinal) || pair.Key.StartsWith("recovery-device:", StringComparison.Ordinal)))
                Assert.Equal(pair.Value, credentials[pair.Key]);
            Assert.True((await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/status", other.Address)).DeviceRegistered);
            Assert.Contains(credentials, pair => pair.Key.StartsWith("recovery-device:", StringComparison.Ordinal) && pair.Value == token);
            await Assert.ThrowsAsync<RemoteInvocationException>(() => desktop.Rpc.InvokeAsync<HostedAccountDto>(
                "collaboration/account/recoverDevice", server.Address, token));
        }
        await using var restored = new HostedDesktop(Path.Combine(temp.Path, "second"), identity, credentials);
        Assert.True((await restored.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/status", server.Address)).DeviceRegistered);
        await restored.SignInAsync(other.Address);
        Assert.True((await restored.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/status", other.Address)).DeviceRegistered);
        var path = Path.Combine(temp.Path, "recovered.txt");
        await restored.Rpc.InvokeAsync("collaboration/account/saveRecoveryToken", server.Address, path);
        Assert.Equal(token, (await File.ReadAllTextAsync(path, ct)).Trim());
    }

    [Theory]
    [InlineData("not-base64")]
    [InlineData("c2hvcnQ=")]
    [InlineData("rejected")]
    public async Task FailedRecoveryDoesNotReplaceCredentials(string reason)
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        server.RejectRegistration = true;
        await using var desktop = new HostedDesktop(temp.Path, identity);
        await desktop.SignInAsync(server.Address);
        var before = JsonSerializer.Serialize(desktop.Credentials.OrderBy(pair => pair.Key));
        var token = reason == "rejected" ? Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)) : reason;
        await Assert.ThrowsAsync<RemoteInvocationException>(() => desktop.Rpc.InvokeAsync<HostedAccountDto>(
            "collaboration/account/recoverDevice", server.Address, token));
        Assert.Equal(before, JsonSerializer.Serialize(desktop.Credentials.OrderBy(pair => pair.Key)));
        Assert.Equal(0, server.ResetCalls);
        Assert.False((await desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/status", server.Address)).DeviceRegistered);
    }

    [Fact]
    public async Task RecoveryRequiresSignInAndCannotRunDuringSharingOrAnotherAccountOperation()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        var credentials = Substitute.For<ICollaborationCredentials>();
        credentials.ReadAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(Task.FromResult<string?>(null));
        await using var accounts = new HostedAccounts(credentials);
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        await Assert.ThrowsAsync<InvalidOperationException>(() => accounts.RecoverDeviceAsync(server.Address, token, ct));
        await Assert.ThrowsAsync<InvalidOperationException>(() => accounts.SaveRecoveryTokenAsync(server.Address, "unused.txt", ct));
        await accounts.SignInAsync(server.Address, identity.OpenBrowserAsync, ct);
        await Assert.ThrowsAsync<InvalidOperationException>(() => accounts.SaveRecoveryTokenAsync(server.Address, "unused.txt", ct));
        await using var rpc = new HostedAccountRpc(accounts, identity.OpenBrowserAsync, _ => true);
        await Assert.ThrowsAsync<InvalidOperationException>(() => rpc.RecoverDeviceAsync(server.Address, token, ct));
    }

    [Fact]
    public async Task PendingRecoveryCanBeCancelledAndRejectsConcurrentOperations()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var desktop = new HostedDesktop(temp.Path, identity);
        await desktop.SignInAsync(server.Address);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        server.Connecting = entered;
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        var pending = desktop.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/recoverDevice", server.Address, token);
        await entered.Task.WaitAsync(ct);
        await Assert.ThrowsAsync<RemoteInvocationException>(() => desktop.Rpc.InvokeAsync<HostedAccountDto>(
            "collaboration/account/recoverDevice", server.Address, token));
        await desktop.Rpc.InvokeAsync("collaboration/account/cancel");
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.Empty(server.Registrations);
    }
}
