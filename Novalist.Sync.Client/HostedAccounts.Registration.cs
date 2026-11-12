using System.Security.Cryptography;
using System.Text.Json;

namespace Novalist.Sync.Client;

public sealed partial class HostedAccounts
{
    // A first sign-in on a server that accepts key-bound proofs registers the device in the same browser visit:
    // the identities exist before sign-in and the sign-in nonce is derived from their public keys.
    private async Task<HostedAccount> SignInAndRegisterAsync(Uri server, HostedSignInOptions settings,
        Func<Uri, CancellationToken, Task> openBrowser, CancellationToken ct)
    {
        using var candidate = DeviceIdentityStore.CreateCandidate();
        var recoveryKey = RandomNumberGenerator.GetBytes(32);
        var salt = RandomNumberGenerator.GetBytes(32);
        try
        {
            using var recovery = RecoveryDeviceIdentity.Derive(recoveryKey);
            var nonce = HostedDeviceEnrollment.EnrollmentNonce(server, candidate.Identity, recovery, salt);
            var (account, identityToken) = browser is null
                ? await HostedSignIn.SignInForEnrollmentAsync(settings, nonce, openBrowser, ct)
                : await HostedSignIn.SignInForEnrollmentAsync(settings, nonce, browser, ct);
            try { await RegisterSignedInDeviceAsync(server, account, candidate, recovery, recoveryKey, identityToken, salt, ct); }
            catch (Exception error) when (!ct.IsCancellationRequested && error is HttpRequestException or InvalidOperationException or
                InvalidDataException or CryptographicException or JsonException or OperationCanceledException)
            {
                // The sign-in itself succeeded. The device stays unregistered and account details offer Register this device.
            }
            catch { await account.DisposeAsync(); throw; }
            return account;
        }
        finally { CryptographicOperations.ZeroMemory(recoveryKey); }
    }

    private async Task RegisterSignedInDeviceAsync(Uri server, HostedAccount account, DeviceIdentityStore.DeviceCandidate candidate,
        DeviceIdentity recovery, byte[] recoveryKey, string identityToken, byte[] salt, CancellationToken ct)
    {
        var devices = new DeviceIdentityStore(credentials);
        var recoveryCredential = RecoveryKey(account);
        if (await devices.ExistsAsync(account.Authority, account.Subject, ct))
        {
            // This device already holds keys for the account, which the sign-in nonce does not cover.
            using var existing = await devices.GetOrCreateAsync(account.Authority, account.Subject, ct);
            await HostedDeviceEnrollment.ConfirmAsync(server, existing, account, ct);
        }
        else
        {
            if (await credentials.ReadAsync(recoveryCredential, ct) is not null)
                throw new InvalidOperationException("This device has a recovery identity without device keys. Register this device again.");
            if (!await devices.TryAdoptAsync(account.Authority, account.Subject, candidate, ct))
                throw new InvalidOperationException("Another sign-in created this device's keys first. Register this device again.");
            await credentials.WriteAsync(recoveryCredential, Convert.ToBase64String(recoveryKey), ct);
            await HostedDeviceEnrollment.EnrollKeyBoundAsync(server, candidate.Identity, recovery, account, identityToken, salt, ct);
        }
        await MarkRegisteredAsync(server, account, ct);
    }

    public async Task<bool> IsDeviceRegisteredAsync(Uri server, HostedAccount account, CancellationToken ct) =>
        (await RegisteredAccountsAsync(server, ct)).Contains(AccountName(account));

    private async Task<bool> HasRegisteredDeviceAsync(Uri server, CancellationToken ct) => (await RegisteredAccountsAsync(server, ct)).Count > 0;

    private async Task MarkRegisteredAsync(Uri server, HostedAccount account, CancellationToken ct)
    {
        var registered = await RegisteredAccountsAsync(server, ct);
        if (registered.Add(AccountName(account)))
            await credentials.WriteAsync(RegisteredKey(server), JsonSerializer.Serialize(registered.Order(StringComparer.Ordinal)), ct);
    }

    private async Task<HashSet<string>> RegisteredAccountsAsync(Uri server, CancellationToken ct)
    {
        var saved = await credentials.ReadAsync(RegisteredKey(server), ct);
        return saved is null ? new(StringComparer.Ordinal) : new(JsonSerializer.Deserialize<string[]>(saved) ?? [], StringComparer.Ordinal);
    }

    private static string AccountName(HostedAccount account) =>
        JsonSerializer.Serialize(new[] { account.Authority.AbsoluteUri.TrimEnd('/'), account.Subject });

    private static string RecoveryKey(HostedAccount account) => "recovery-device:" + AccountName(account);

    // Accounts whose device identity on this computer the server has accepted. Kept across sign-out.
    private static string RegisteredKey(Uri server)
    {
        HostedSignIn.ValidateAddress(server);
        return "registered-devices:" + server.AbsoluteUri.TrimEnd('/');
    }
}
