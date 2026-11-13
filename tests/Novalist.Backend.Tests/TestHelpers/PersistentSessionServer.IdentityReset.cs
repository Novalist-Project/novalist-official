using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.IdentityModel.JsonWebTokens;

namespace Novalist.Backend.Tests.TestHelpers;

internal sealed partial class PersistentSessionServer
{
    internal bool ResetSupported { get; set; }
    internal bool RejectReset { get; set; }
    internal int ResetCalls { get; private set; }
    internal Guid ResetUser { get; private set; }
    private readonly Dictionary<Guid, string> resetChallenges = [];

    private void MapIdentityResetEndpoints()
    {
        app.MapPost("/account/reset/challenge", () =>
        {
            var id = Guid.NewGuid();
            var nonce = "novalist/account-reset/" + Guid.NewGuid();
            lock (gate) resetChallenges[id] = nonce;
            return new { id, nonce, expiresAt = DateTimeOffset.UtcNow.AddMinutes(5) };
        });
        app.MapPost("/account/reset", (HttpContext context, ResetRequest request) =>
        {
            lock (gate)
            {
                ResetCalls++;
                var token = new JsonWebToken(request.IdentityToken);
                if (RejectReset || !request.ForfeitProjectAccess || !resetChallenges.TryGetValue(request.ChallengeId, out var nonce) ||
                    token.GetClaim("nonce").Value != nonce || !token.Claims.Any(claim => claim.Type == "amr" && claim.Value == "mfa"))
                    return Results.Problem(statusCode: 403);
                resetChallenges.Remove(request.ChallengeId);
                accounts[context.Request.Headers.Authorization.ToString()] = ResetUser = Guid.NewGuid();
                return Results.Ok(new { userId = ResetUser });
            }
        });
    }

    internal sealed record ResetRequest(Guid ChallengeId, string IdentityToken, bool ForfeitProjectAccess);
}
