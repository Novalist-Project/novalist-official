using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.IdentityModel.Tokens;
using NSec.Cryptography;

namespace Novalist.Sync.Client;

public sealed record DevicePairingRequest(string Request, string DeviceName, string Fingerprint, DateTimeOffset ExpiresAt);

internal sealed partial class HostedDeviceRegistration
{
    private const string PairingPrefix = "novalist-device:";

    internal async Task<DevicePairingRequest> CreatePairingAsync(HttpClient http, string token, string name, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Trim().Length > 80 || name.Any(char.IsControl))
            throw new ArgumentException("Enter a device name of 1 to 80 characters.", nameof(name));
        var user = await DiscoverAsync(http, token, Guid.Empty, ct);
        var registration = CreateRegistration(user, null, null);
        var payload = new PairingPayload(1, server.AbsoluteUri, user, registration.Keys, registration.Signature,
            name.Trim(), DateTimeOffset.UtcNow.AddMinutes(15));
        var proof = SignatureAlgorithm.Ed25519.Sign(device.SigningKey, PairingProof(payload));
        var request = PairingPrefix + Base64UrlEncoder.Encode(JsonSerializer.SerializeToUtf8Bytes(new PairingEnvelope(payload, proof)));
        return Preview(request, payload);
    }

    internal async Task<DevicePairingRequest> ReviewPairingAsync(HttpClient http, string token, string request, CancellationToken ct)
    {
        var payload = ParsePairing(request);
        await DiscoverAsync(http, token, payload.UserId, ct);
        if (payload.Keys.DeviceId == device.Id) throw new InvalidOperationException("Use a different authorized device to approve this request.");
        return Preview(request.Trim(), payload);
    }

    internal async Task ApprovePairingAsync(HttpClient http, string token, string request, CancellationToken ct)
    {
        var payload = ParsePairing(request);
        var user = await DiscoverAsync(http, token, payload.UserId, ct);
        if (payload.Keys.DeviceId == device.Id) throw new InvalidOperationException("Use a different authorized device to approve this request.");
        await SendAsync(http, token, new(payload.Keys, payload.Signature, device.Id, LinkSignature(user, device, payload.Keys), null), ct);
    }

    internal async Task ConfirmPairingAsync(HttpClient http, string token, string request, CancellationToken ct)
    {
        var payload = ParsePairing(request);
        var keys = ExportKeys(device);
        if (payload.Keys.DeviceId != keys.DeviceId || !payload.Keys.SigningPublicKey.AsSpan().SequenceEqual(keys.SigningPublicKey) ||
            !payload.Keys.ReceivingPublicKey.AsSpan().SequenceEqual(keys.ReceivingPublicKey))
            throw new CryptographicException("The pairing request belongs to another device.");
        try { await RegisterAsync(http, token, payload.UserId, null, null, ct); }
        catch (HttpRequestException error) when (error.StatusCode == System.Net.HttpStatusCode.Forbidden)
        {
            throw new InvalidOperationException("This device has not been approved, or its approval was revoked. Approve the current request on an authorized device, then check again.", error);
        }
    }

    internal DevicePairingRequest ReadPairing(string request) => Preview(request.Trim(), ParsePairing(request));

    private PairingPayload ParsePairing(string request)
    {
        if (request.Length > 8192 || !request.Trim().StartsWith(PairingPrefix, StringComparison.Ordinal))
            throw new InvalidDataException("Enter a valid device pairing request.");
        PairingEnvelope? envelope;
        try
        {
            envelope = JsonSerializer.Deserialize<PairingEnvelope>(Base64UrlEncoder.DecodeBytes(request.Trim()[PairingPrefix.Length..]),
                new JsonSerializerOptions { MaxDepth = 8 });
        }
        catch (Exception error) when (error is FormatException or JsonException or ArgumentException)
        { throw new InvalidDataException("Enter a valid device pairing request.", error); }
        if (envelope?.Payload is not { Version: 1, Keys: { SigningPublicKey.Length: 32, ReceivingPublicKey.Length: 32 },
                Signature.Length: 64, DeviceName.Length: > 0 and <= 80 } payload || envelope.Proof is not { Length: 64 } ||
            payload.UserId == Guid.Empty || payload.Keys.DeviceId == Guid.Empty || payload.DeviceName.Any(char.IsControl))
            throw new InvalidDataException("The device pairing request is incomplete.");
        if (payload.Server != server.AbsoluteUri) throw new CryptographicException("The pairing request belongs to another server.");
        if (payload.ExpiresAt <= DateTimeOffset.UtcNow || payload.ExpiresAt > DateTimeOffset.UtcNow.AddMinutes(16))
            throw new InvalidDataException("The device pairing request has expired. Generate a new request on the new device.");
        var signing = PublicKey.Import(SignatureAlgorithm.Ed25519, payload.Keys.SigningPublicKey, KeyBlobFormat.RawPublicKey);
        var receiving = PublicKey.Import(KeyAgreementAlgorithm.X25519, payload.Keys.ReceivingPublicKey, KeyBlobFormat.RawPublicKey);
        if (DeviceIdentity.IdForKeys(signing, receiving) != payload.Keys.DeviceId ||
            !SignatureAlgorithm.Ed25519.Verify(signing, PairingProof(payload), envelope.Proof) ||
            !SignatureAlgorithm.Ed25519.Verify(signing, RegistrationProof(payload.UserId, payload.Keys), payload.Signature))
            throw new CryptographicException("The device pairing request signature is invalid.");
        return payload;
    }

    private static byte[] PairingProof(PairingPayload payload) =>
        [.. "novalist/v1/device-pairing"u8, .. JsonSerializer.SerializeToUtf8Bytes(payload)];

    private static DevicePairingRequest Preview(string request, PairingPayload payload)
    {
        var hash = Convert.ToHexString(SHA256.HashData(EncodeKeys(payload.Keys)))[..32];
        var fingerprint = string.Join(" ", Enumerable.Range(0, 8).Select(index => hash.Substring(index * 4, 4)));
        return new(request, payload.DeviceName, fingerprint, payload.ExpiresAt);
    }

    private sealed record PairingPayload(int Version, string Server, Guid UserId, PublicKeys Keys, byte[] Signature,
        string DeviceName, DateTimeOffset ExpiresAt);
    private sealed record PairingEnvelope(PairingPayload Payload, byte[] Proof);
}
