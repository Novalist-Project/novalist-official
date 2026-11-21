using System.Text.Json;

namespace Novalist.Sync.Client;

public sealed partial class HostedAccounts
{
    public Task<DevicePairingRequest> CreateDevicePairingAsync(Uri server, string deviceName, CancellationToken ct) =>
        WithPairingAccountAsync(server, false, async (account, token) =>
        {
            var pending = await ReadPendingPairingAsync(server, account, token);
            var devices = new DeviceIdentityStore(credentials);
            if (pending is not null)
            {
                using var existing = await devices.GetOrCreateAsync(account.Authority, account.DeviceSubject, token);
                var registration = Registration(server, existing);
                var preview = registration.ReadPairing(pending.Request);
                if (preview.DeviceName == deviceName.Trim()) return preview;
            }
            using var candidate = DeviceIdentityStore.CreateCandidate();
            using var http = HostedDeviceEnrollment.CreateHttpClient();
            var request = await Registration(server, candidate.Identity).CreatePairingAsync(http, await account.GetAccessTokenAsync(token), deviceName, token);
            using var saveTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            if (!await devices.TryAdoptAsync(account.Authority, "reset:" + candidate.Identity.Id, candidate, saveTimeout.Token))
                throw new InvalidOperationException("The pairing device identity already exists.");
            await SaveDeviceNamespaceAsync(server, account, candidate.Identity.Id, saveTimeout.Token);
            await credentials.WriteAsync(PairingKey(server), JsonSerializer.Serialize(new PendingPairing(AccountName(account), request.Request, request.ExpiresAt)), saveTimeout.Token);
            return request;
        }, ct);

    public Task<DevicePairingRequest> ReviewDevicePairingAsync(Uri server, string request, CancellationToken ct) =>
        WithPairingAccountAsync(server, true, async (account, token) =>
        {
            using var device = await new DeviceIdentityStore(credentials).GetOrCreateAsync(account.Authority, account.DeviceSubject, token);
            using var http = HostedDeviceEnrollment.CreateHttpClient();
            return await Registration(server, device).ReviewPairingAsync(http, await account.GetAccessTokenAsync(token), request, token);
        }, ct);

    public Task<bool> ApproveDevicePairingAsync(Uri server, string request, CancellationToken ct) =>
        WithPairingAccountAsync(server, true, async (account, token) =>
        {
            using var device = await new DeviceIdentityStore(credentials).GetOrCreateAsync(account.Authority, account.DeviceSubject, token);
            using var http = HostedDeviceEnrollment.CreateHttpClient();
            await Registration(server, device).ApprovePairingAsync(http, await account.GetAccessTokenAsync(token), request, token);
            return true;
        }, ct);

    public Task<HostedAccount> CompleteDevicePairingAsync(Uri server, CancellationToken ct) =>
        WithPairingAccountAsync(server, false, async (account, token) =>
        {
            var pending = await ReadPendingPairingAsync(server, account, token)
                ?? throw new InvalidOperationException("Generate a device pairing request first.");
            using var device = await new DeviceIdentityStore(credentials).GetOrCreateAsync(account.Authority, account.DeviceSubject, token);
            using var http = HostedDeviceEnrollment.CreateHttpClient();
            await Registration(server, device).ConfirmPairingAsync(http, await account.GetAccessTokenAsync(token), pending.Request, token);
            await MarkRegisteredAsync(server, account, token);
            await credentials.RemoveAsync(PairingKey(server), token);
            return account;
        }, ct);

    private async Task<T> WithPairingAccountAsync<T>(Uri server, bool registered, Func<HostedAccount, CancellationToken, Task<T>> action, CancellationToken ct)
    {
        using var operation = BeginOperation(ct);
        ct = operation.Token;
        var account = await RestoreAsync(server, ct) ?? throw new InvalidOperationException("Sign in before pairing devices.");
        await gate.WaitAsync(ct);
        try
        {
            if (await IsDeviceRegisteredAsync(server, account, ct) != registered)
                throw new InvalidOperationException(registered ? "Use a registered device to approve pairing." : "This device is already registered.");
            return await action(account, ct);
        }
        finally { gate.Release(); }
    }

    private async Task<PendingPairing?> ReadPendingPairingAsync(Uri server, HostedAccount account, CancellationToken ct)
    {
        var saved = await credentials.ReadAsync(PairingKey(server), ct);
        if (saved is null) return null;
        var pending = JsonSerializer.Deserialize<PendingPairing>(saved) ?? throw new InvalidDataException("The saved pairing request is invalid.");
        return pending.Account == AccountName(account) && pending.ExpiresAt > DateTimeOffset.UtcNow ? pending : null;
    }

    private static HostedDeviceRegistration Registration(Uri server, DeviceIdentity device) => new(new(server.AbsoluteUri.TrimEnd('/') + '/'), device);
    private static string PairingKey(Uri server) => "device-pairing:" + server.AbsoluteUri.TrimEnd('/');
    private sealed record PendingPairing(string Account, string Request, DateTimeOffset ExpiresAt);
}
