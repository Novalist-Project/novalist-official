#if NOVALIST_COLLABORATION
using Novalist.Sync.Client;
using StreamJsonRpc;

namespace Novalist.Backend.Rpc;

public sealed partial class HostedAccountRpc
{
    [JsonRpcMethod("collaboration/account/createDevicePairing")]
    public Task<DevicePairingRequest> CreateDevicePairingAsync(Uri server, string deviceName, CancellationToken cancellationToken = default) =>
        PairingAsync(server, true, ct => accounts.CreateDevicePairingAsync(server, deviceName, ct), cancellationToken);

    [JsonRpcMethod("collaboration/account/reviewDevicePairing")]
    public Task<DevicePairingRequest> ReviewDevicePairingAsync(Uri server, string request, CancellationToken cancellationToken = default) =>
        PairingAsync(server, false, ct => accounts.ReviewDevicePairingAsync(server, request, ct), cancellationToken);

    [JsonRpcMethod("collaboration/account/approveDevicePairing")]
    public Task<bool> ApproveDevicePairingAsync(Uri server, string request, CancellationToken cancellationToken = default) =>
        PairingAsync(server, false, ct => accounts.ApproveDevicePairingAsync(server, request, ct), cancellationToken);

    [JsonRpcMethod("collaboration/account/completeDevicePairing")]
    public Task<HostedAccountDto> CompleteDevicePairingAsync(Uri server, CancellationToken cancellationToken = default) =>
        PairingAsync(server, true, async ct => await ViewAsync(server, await accounts.CompleteDevicePairingAsync(server, ct), ct), cancellationToken);

    private async Task<T> PairingAsync<T>(Uri server, bool changesLocalDevice, Func<CancellationToken, Task<T>> action, CancellationToken ct)
    {
        if (changesLocalDevice && isSharing(server)) throw new InvalidOperationException("End the collaboration session before pairing this device.");
        CancellationTokenSource operation;
        lock (gate)
        {
            if (signIn is not null) throw new InvalidOperationException("An account operation is already in progress.");
            signIn = operation = CancellationTokenSource.CreateLinkedTokenSource(ct);
        }
        try { return await action(operation.Token); }
        finally { lock (gate) { signIn = null; operation.Dispose(); } }
    }
}
#endif
