using System.Security.Cryptography;

namespace Novalist.Sync.Client;

public sealed partial class HostedAccounts
{
    public async Task<HostedAccount> RecoverDeviceAsync(Uri server, string recoveryToken, CancellationToken ct)
    {
        var recoveryKey = new byte[32];
        try
        {
            if (!Convert.TryFromBase64String(recoveryToken.Trim(), recoveryKey, out var length) || length != recoveryKey.Length)
                throw new ArgumentException("Enter a valid recovery token containing 32 bytes.", nameof(recoveryToken));
            using var operation = BeginOperation(ct);
            ct = operation.Token;
            var account = await RestoreAsync(server, ct) ?? throw new InvalidOperationException("Sign in before recovering this device.");
            await gate.WaitAsync(ct);
            try
            {
                if (await IsDeviceRegisteredAsync(server, account, ct))
                    throw new InvalidOperationException("This device is already registered.");
                using var recovery = RecoveryDeviceIdentity.Derive(recoveryKey);
                using var candidate = DeviceIdentityStore.CreateCandidate();
                await HostedDeviceEnrollment.LinkAsync(server, recovery, candidate.Identity, await account.GetAccessTokenAsync(ct), ct);
                using var saveTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                var devices = new DeviceIdentityStore(credentials);
                var deviceNamespace = candidate.Identity.Id;
                if (!await devices.TryAdoptAsync(account.Authority, "reset:" + deviceNamespace, candidate, saveTimeout.Token))
                    throw new InvalidOperationException("The replacement device identity already exists.");
                await SaveDeviceNamespaceAsync(server, account, deviceNamespace, saveTimeout.Token);
                await credentials.WriteAsync(RecoveryKey(account), Convert.ToBase64String(recoveryKey), saveTimeout.Token);
                await MarkRegisteredAsync(server, account, saveTimeout.Token);
                return account;
            }
            finally { gate.Release(); }
        }
        finally { CryptographicOperations.ZeroMemory(recoveryKey); }
    }

    public async Task SaveRecoveryTokenAsync(Uri server, string outputPath, CancellationToken ct)
    {
        using var operation = BeginOperation(ct);
        ct = operation.Token;
        var account = await RestoreAsync(server, ct) ?? throw new InvalidOperationException("Sign in before saving a recovery token.");
        if (!await IsDeviceRegisteredAsync(server, account, ct))
            throw new InvalidOperationException("Register this device before saving a recovery token.");
        var token = await GetRecoveryTokenAsync(account, ct) ?? throw new InvalidOperationException("No recovery token is saved for this device.");
        var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write, Options = FileOptions.Asynchronous };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        await using var file = new FileStream(outputPath, options);
        await using var writer = new StreamWriter(file);
        await writer.WriteLineAsync(token.AsMemory(), ct);
    }
}
