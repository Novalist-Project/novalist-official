using System.Text.Json.Nodes;
using Microsoft.IdentityModel.Tokens;
using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Sync.Client;
using Novalist.Sync.Client.Tests;
using NSubstitute;
using StreamJsonRpc;
using Xunit;

namespace Novalist.Backend.Tests;

[Collection("BackendStatics")]
public sealed class PersistentDevicePairingTests
{
    [Fact]
    public async Task PairingSurvivesRestartAndCompletesOnlyAfterApprovalWithoutCopyingRecoverySecrets()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        identity.IssueAccessToken = () => "pairing-writer";
        identity.MultiFactorAuthentication = true;
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var existing = new HostedDesktop(Path.Combine(temp.Path, "existing"), identity);
        await existing.SignInAsync(server.Address);
        await existing.Rpc.InvokeAsync("collaboration/account/enrollDevice", server.Address);
        var root = Assert.Single(server.Registrations).Keys.DeviceId;
        var credentials = new Dictionary<string, string>();
        DevicePairingRequest request;
        await using (var incoming = new HostedDesktop(Path.Combine(temp.Path, "incoming"), identity, credentials))
        {
            await incoming.SignInAsync(server.Address);
            await Assert.ThrowsAsync<RemoteInvocationException>(() => incoming.Rpc.InvokeAsync<HostedAccountDto>(
                "collaboration/account/completeDevicePairing", server.Address));
            request = await incoming.Rpc.InvokeAsync<DevicePairingRequest>("collaboration/account/createDevicePairing", server.Address, "Writing laptop");
            Assert.Equal("Writing laptop", request.DeviceName);
            Assert.InRange(request.ExpiresAt, DateTimeOffset.UtcNow.AddMinutes(14), DateTimeOffset.UtcNow.AddMinutes(16));
            Assert.DoesNotContain(credentials.Keys, key => key.StartsWith("recovery-device:", StringComparison.Ordinal));
            server.RejectRegistration = true;
            await Assert.ThrowsAsync<RemoteInvocationException>(() => incoming.Rpc.InvokeAsync<HostedAccountDto>(
                "collaboration/account/completeDevicePairing", server.Address));
            Assert.False((await incoming.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/status", server.Address)).DeviceRegistered);
            server.RejectRegistration = false;
        }
        await using var restored = new HostedDesktop(Path.Combine(temp.Path, "restored"), identity, credentials);
        Assert.Equal(request, await restored.Rpc.InvokeAsync<DevicePairingRequest>("collaboration/account/createDevicePairing", server.Address, "Writing laptop"));
        var preview = await existing.Rpc.InvokeAsync<DevicePairingRequest>("collaboration/account/reviewDevicePairing", server.Address, request.Request);
        Assert.Equal(request.Fingerprint, preview.Fingerprint);
        Assert.Single(server.Registrations);
        Assert.True(await existing.Rpc.InvokeAsync<bool>("collaboration/account/approveDevicePairing", server.Address, preview.Request));
        var approved = server.Registrations[1];
        Assert.Equal(root, approved.LinkedByDeviceId);
        Assert.NotEqual(root, approved.Keys.DeviceId);
        Assert.Null(approved.RecoveryDevice);
        var completed = await restored.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/completeDevicePairing", server.Address);
        Assert.True(completed.DeviceRegistered);
        Assert.False(completed.HasRecoveryToken);
        Assert.Null(completed.RecoveryToken);
        Assert.DoesNotContain(credentials.Keys, key => key.StartsWith("device-pairing:", StringComparison.Ordinal));
        Assert.True((await existing.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/status", server.Address)).HasRecoveryToken);
        Assert.Equal(0, server.ResetCalls);
        await Assert.ThrowsAsync<RemoteInvocationException>(() => restored.Rpc.InvokeAsync<DevicePairingRequest>(
            "collaboration/account/createDevicePairing", server.Address, "Already registered"));
    }

    [Theory]
    [InlineData("malformed")]
    [InlineData("name")]
    [InlineData("signature")]
    [InlineData("expired")]
    [InlineData("version")]
    [InlineData("oversized")]
    public async Task InvalidRequestsCannotBeReviewedOrApproved(string change)
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        identity.MultiFactorAuthentication = true;
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var existing = new HostedDesktop(Path.Combine(temp.Path, "existing"), identity);
        await existing.SignInAsync(server.Address);
        await existing.Rpc.InvokeAsync("collaboration/account/enrollDevice", server.Address);
        await using var incoming = new HostedDesktop(Path.Combine(temp.Path, "incoming"), identity);
        await incoming.SignInAsync(server.Address);
        var request = await incoming.Rpc.InvokeAsync<DevicePairingRequest>("collaboration/account/createDevicePairing", server.Address, "New device");
        var code = request.Request;
        var json = JsonNode.Parse(Base64UrlEncoder.Decode(code["novalist-device:".Length..]))!.AsObject();
        if (change == "name") json["Payload"]!["DeviceName"] = "Changed name";
        if (change == "expired") json["Payload"]!["ExpiresAt"] = DateTimeOffset.UtcNow.AddMinutes(-1);
        if (change == "version") json["Payload"]!["Version"] = 2;
        if (change == "signature") json["Proof"] = Convert.ToBase64String(new byte[64]);
        code = change == "malformed" ? "novalist-device:broken" : change == "oversized" ? new string('x', 8193)
            : "novalist-device:" + Base64UrlEncoder.Encode(json.ToJsonString());
        foreach (var method in new[] { "collaboration/account/reviewDevicePairing", "collaboration/account/approveDevicePairing" })
            await Assert.ThrowsAsync<RemoteInvocationException>(() => existing.Rpc.InvokeAsync<object>(method, server.Address, code));
        Assert.Single(server.Registrations);
        Assert.False((await incoming.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/status", server.Address)).DeviceRegistered);
    }

    [Fact]
    public async Task RequestsAreBoundToTheServerAndAccountAndRequireARegisteredApprover()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        identity.IssueAccessToken = () => identity.Subject;
        identity.MultiFactorAuthentication = true;
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var otherServer = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var incoming = new HostedDesktop(Path.Combine(temp.Path, "incoming"), identity);
        await incoming.SignInAsync(server.Address);
        await Assert.ThrowsAsync<RemoteInvocationException>(() => incoming.Rpc.InvokeAsync<DevicePairingRequest>(
            "collaboration/account/createDevicePairing", server.Address, ""));
        var request = await incoming.Rpc.InvokeAsync<DevicePairingRequest>("collaboration/account/createDevicePairing", server.Address, "New device");
        await Assert.ThrowsAsync<RemoteInvocationException>(() => incoming.Rpc.InvokeAsync<DevicePairingRequest>(
            "collaboration/account/reviewDevicePairing", server.Address, request.Request));
        await using var approver = new HostedDesktop(Path.Combine(temp.Path, "approver"), identity);
        await approver.SignInAsync(otherServer.Address);
        await approver.Rpc.InvokeAsync("collaboration/account/enrollDevice", otherServer.Address);
        await Assert.ThrowsAsync<RemoteInvocationException>(() => approver.Rpc.InvokeAsync<DevicePairingRequest>(
            "collaboration/account/reviewDevicePairing", otherServer.Address, request.Request));
        identity.Subject = "different-account";
        await approver.SignInAsync(server.Address);
        await approver.Rpc.InvokeAsync("collaboration/account/enrollDevice", server.Address);
        await Assert.ThrowsAsync<RemoteInvocationException>(() => approver.Rpc.InvokeAsync<bool>(
            "collaboration/account/approveDevicePairing", server.Address, request.Request));
        Assert.Single(server.Registrations);
    }

    [Fact]
    public async Task ChangingTheDeviceNameCreatesFreshKeysAndRetainsThePreviousKeys()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var incoming = new HostedDesktop(temp.Path, identity);
        await incoming.SignInAsync(server.Address);
        var original = await incoming.Rpc.InvokeAsync<DevicePairingRequest>("collaboration/account/createDevicePairing", server.Address, "Old name");
        var keys = Assert.Single(incoming.Credentials, pair => pair.Key.StartsWith("device:", StringComparison.Ordinal));

        var replacement = await incoming.Rpc.InvokeAsync<DevicePairingRequest>("collaboration/account/createDevicePairing", server.Address, "New name");

        Assert.Equal("New name", replacement.DeviceName);
        Assert.NotEqual(original.Request, replacement.Request);
        Assert.NotEqual(original.Fingerprint, replacement.Fingerprint);
        Assert.Equal(keys.Value, incoming.Credentials[keys.Key]);
        Assert.Equal(replacement, await incoming.Rpc.InvokeAsync<DevicePairingRequest>("collaboration/account/createDevicePairing", server.Address, "New name"));
        Assert.False((await incoming.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/status", server.Address)).DeviceRegistered);
        Assert.Empty(server.Registrations);
    }

    [Fact]
    public async Task PairingNeverOverwritesAnIdentityCreatedConcurrently()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        var credentials = Substitute.For<ICollaborationCredentials>();
        credentials.ReadAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(call => Task.FromResult<string?>(
            call.ArgAt<string>(0).StartsWith("device:", StringComparison.Ordinal) && call.ArgAt<string>(0).Contains("reset:", StringComparison.Ordinal)
                ? "existing identity" : null));
        await using var accounts = new HostedAccounts(credentials);
        await accounts.SignInAsync(server.Address, identity.OpenBrowserAsync, ct);

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => accounts.CreateDevicePairingAsync(server.Address, "Device", ct));

        Assert.Equal("The pairing device identity already exists.", error.Message);
        await credentials.DidNotReceive().WriteAsync(Arg.Is<string>(key => key.StartsWith("device:", StringComparison.Ordinal)), Arg.Any<string>(), Arg.Any<CancellationToken>());
        await credentials.DidNotReceive().WriteAsync(Arg.Is<string>(key => key.StartsWith("device-namespace:", StringComparison.Ordinal)), Arg.Any<string>(), Arg.Any<CancellationToken>());
        Assert.Empty(server.Registrations);
    }

    [Fact]
    public async Task CompletingAnotherDevicesRequestDoesNotRegisterOrReplaceTheLocalDevice()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var first = new HostedDesktop(Path.Combine(temp.Path, "first"), identity);
        await using var second = new HostedDesktop(Path.Combine(temp.Path, "second"), identity);
        await first.SignInAsync(server.Address);
        await second.SignInAsync(server.Address);
        await first.Rpc.InvokeAsync<DevicePairingRequest>("collaboration/account/createDevicePairing", server.Address, "First device");
        var other = await second.Rpc.InvokeAsync<DevicePairingRequest>("collaboration/account/createDevicePairing", server.Address, "Second device");
        var saved = Assert.Single(first.Credentials, pair => pair.Key.StartsWith("device-pairing:", StringComparison.Ordinal));
        var pending = JsonNode.Parse(saved.Value)!.AsObject();
        pending["Request"] = other.Request;
        first.Credentials[saved.Key] = pending.ToJsonString();
        var keys = Assert.Single(first.Credentials, pair => pair.Key.StartsWith("device:", StringComparison.Ordinal));

        var error = await Assert.ThrowsAsync<RemoteInvocationException>(() => first.Rpc.InvokeAsync<HostedAccountDto>(
            "collaboration/account/completeDevicePairing", server.Address));

        Assert.Contains("The pairing request belongs to another device.", error.Message);
        Assert.Equal(keys.Value, first.Credentials[keys.Key]);
        Assert.False((await first.Rpc.InvokeAsync<HostedAccountDto>("collaboration/account/status", server.Address)).DeviceRegistered);
        Assert.Empty(server.Registrations);
    }

    [Fact]
    public async Task PairingGuardsSharingAndConcurrentAccountOperationsAndCanBeCancelled()
    {
        var ct = TestContext.Current.CancellationToken;
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        var credentials = Substitute.For<ICollaborationCredentials>();
        credentials.ReadAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(Task.FromResult<string?>(null));
        await using var accounts = new HostedAccounts(credentials);
        var sharing = true;
        await using var rpc = new HostedAccountRpc(accounts, identity.OpenBrowserAsync, _ => sharing);
        await Assert.ThrowsAsync<InvalidOperationException>(() => rpc.CreateDevicePairingAsync(server.Address, "Device", ct));
        await Assert.ThrowsAsync<InvalidOperationException>(() => rpc.CompleteDevicePairingAsync(server.Address, ct));
        sharing = false;
        await Assert.ThrowsAsync<InvalidOperationException>(() => rpc.CreateDevicePairingAsync(server.Address, "Device", ct));
        await accounts.SignInAsync(server.Address, identity.OpenBrowserAsync, ct);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        server.Connecting = entered;
        var pending = rpc.CreateDevicePairingAsync(server.Address, "Device", ct);
        await entered.Task.WaitAsync(ct);
        await Assert.ThrowsAsync<InvalidOperationException>(() => rpc.CreateDevicePairingAsync(server.Address, "Device", ct));
        rpc.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        Assert.Empty(server.Registrations);
    }
}
