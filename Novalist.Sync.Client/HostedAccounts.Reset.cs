using System.Net.Http.Headers;
using System.Net.Http.Json;

namespace Novalist.Sync.Client;

public sealed partial class HostedAccounts
{
    public async Task<HostedAccount> ResetIdentityAsync(Uri server, bool forfeitProjectAccess,
        Func<Uri, CancellationToken, Task> openBrowser, CancellationToken ct)
    {
        if (!forfeitProjectAccess) throw new InvalidOperationException("Confirm that all existing project access will be forfeited.");
        using var operation = BeginOperation(ct);
        ct = operation.Token;
        var account = await RestoreAsync(server, ct) ?? throw new InvalidOperationException("Sign in before resetting this identity.");
        await gate.WaitAsync(ct);
        try
        {
            if (!(await RelayServerDiscovery.DiscoverAsync(server, ct)).AccountIdentityReset)
                throw new InvalidOperationException("This server does not support lost-device identity resets.");
            using var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
                { MaxResponseContentBufferSize = 64 * 1024 };
            var address = new Uri(server.AbsoluteUri.TrimEnd('/') + '/');
            using var start = new HttpRequestMessage(HttpMethod.Post, new Uri(address, "account/reset/challenge"));
            start.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await account.GetAccessTokenAsync(ct));
            using var started = await http.SendAsync(start, ct);
            started.EnsureSuccessStatusCode();
            var challenge = await started.Content.ReadFromJsonAsync<IdentityResetChallenge>(ct);
            if (challenge is null || challenge.Id == Guid.Empty || string.IsNullOrEmpty(challenge.Nonce) ||
                challenge.Nonce.Length > 256 || challenge.ExpiresAt <= DateTimeOffset.UtcNow)
                throw new InvalidDataException("The server returned an invalid identity reset challenge.");
            var proof = browser is null
                ? await HostedSignIn.AuthenticateEnrollmentAsync(account, challenge.Nonce, openBrowser, ct)
                : await HostedSignIn.AuthenticateEnrollmentAsync(account, challenge.Nonce, browser, ct);
            using var confirm = new HttpRequestMessage(HttpMethod.Post, new Uri(address, "account/reset"));
            confirm.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await account.GetAccessTokenAsync(ct));
            confirm.Content = JsonContent.Create(new { challengeId = challenge.Id, identityToken = proof, forfeitProjectAccess = true });
            using var response = await http.SendAsync(confirm, ct);
            response.EnsureSuccessStatusCode();
            var reset = await response.Content.ReadFromJsonAsync<IdentityResetResult>(ct);
            if (reset is null || reset.UserId == Guid.Empty) throw new InvalidDataException("The server returned an invalid reset identity.");
            // Keep the old keys for local copies and other servers. New enrollment gets a separate namespace.
            using var saveTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await credentials.WriteAsync(DeviceNamespaceKey(server, account), reset.UserId.ToString(), saveTimeout.Token);
            await account.ResetDeviceSubjectAsync(reset.UserId, saveTimeout.Token);
            await credentials.RemoveAsync(PendingKey(server), saveTimeout.Token);
            registrationErrors.TryRemove(AccountKey(server), out _);
            return account;
        }
        finally { gate.Release(); }
    }

    private async Task RestoreDeviceSubjectAsync(Uri server, HostedAccount account, CancellationToken ct)
    {
        var saved = await credentials.ReadAsync(DeviceNamespaceKey(server, account), ct);
        if (saved is not null)
        {
            if (!Guid.TryParse(saved, out var user) || user == Guid.Empty)
                throw new InvalidDataException("The saved reset identity is invalid.");
            await account.ResetDeviceSubjectAsync(user, ct);
        }
    }

    private static string DeviceNamespaceKey(Uri server, HostedAccount account) => "device-namespace:" +
        System.Text.Json.JsonSerializer.Serialize(new[] { server.AbsoluteUri.TrimEnd('/'), account.Authority.AbsoluteUri.TrimEnd('/'), account.Subject });

    private sealed record IdentityResetChallenge(Guid Id, string Nonce, DateTimeOffset ExpiresAt);
    private sealed record IdentityResetResult(Guid UserId);
}
