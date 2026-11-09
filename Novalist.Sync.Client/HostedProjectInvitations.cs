using System.Security.Cryptography;
using NSec.Cryptography;

namespace Novalist.Sync.Client;

// FirstServerSequence: where the history starts after a compaction; null keeps the access state's own boundary.
public sealed record HostedInvitationOptions(CheckpointReference Checkpoint, DateTimeOffset ExpiresAt, long? FirstServerSequence = null);

public static class HostedProjectInvitations
{
    public static async Task<string> CreateAsync(HostedProjectAccess access, DeviceIdentity device, HostedTransport transport,
        HostedInvitationOptions options, CancellationToken ct)
    {
        access.CheckTransport(transport);
        if (!transport.IsConnected) throw new InvalidOperationException("Connect before inviting a collaborator.");
        var identity = access.CreateSessionIdentity(device);
        if (identity.Membership.VerifyCertificate(device.Id, identity.Certificate).Role != ProjectRole.Owner)
            throw new InvalidOperationException("Only the project owner can invite collaborators.");
        using var delegation = Key.Create(SignatureAlgorithm.Ed25519, new() { ExportPolicy = KeyExportPolicies.AllowPlaintextExport });
        var invitation = Guid.NewGuid();
        var grant = identity.Membership.CreateInvitation(new(Guid.NewGuid(), DateTimeOffset.UtcNow, options.ExpiresAt),
            delegation.PublicKey, device.SigningKey);
        var secret = delegation.Export(KeyBlobFormat.RawPrivateKey);
        try
        {
            var state = options.FirstServerSequence is { } first ? access.State with { FirstServerSequence = first } : access.State;
            var link = HostedInvitationBootstrap.Encode(state, invitation, grant, secret, options.Checkpoint);
            await transport.CreateInvitationAsync(access.ProjectId, invitation, options.ExpiresAt, ct);
            return link;
        }
        finally { CryptographicOperations.ZeroMemory(secret); }
    }
}
