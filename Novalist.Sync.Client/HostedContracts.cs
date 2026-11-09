namespace Novalist.Sync.Client;

public sealed record HostedDeviceChallenge(Guid UserId, Guid DeviceId, Guid Nonce, string ServerUrl);
public sealed record HostedInvitationGrant(Guid ProjectId);
public sealed record HostedInvitationRequest(Guid InvitationId, DateTimeOffset ExpiresAt);
public sealed record HostedInvitationActivationRequest(Guid InvitationId, byte[] CertificateHash);
public sealed record HostedInvitationActivation(Guid ProjectId, Guid DeviceId, byte[] CertificateHash);

// Stable refusal texts the server sends (Protocol.TransitionInProgress and Protocol.HistoryReplaced in its contracts).
public static class HostedProtocol
{
    public const string TransitionInProgress = "A project key rotation or history compaction is in progress. Retry shortly.";
    public const string HistoryReplaced = "This project's earlier history was replaced by a checkpoint.";

    public static bool IsTransitionInProgress(Exception error) => error is Microsoft.AspNetCore.SignalR.HubException &&
        error.Message.Contains(TransitionInProgress, StringComparison.Ordinal);

    public static bool IsHistoryReplaced(Exception? error) => error is Microsoft.AspNetCore.SignalR.HubException &&
        error.Message.Contains(HistoryReplaced, StringComparison.Ordinal);
}
