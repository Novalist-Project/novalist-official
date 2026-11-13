using System.Net;
using System.Runtime.CompilerServices;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Novalist.Sync.Client;

namespace Novalist.Backend.Tests.TestHelpers;

internal sealed partial class PersistentSessionServer : IAsyncDisposable
{
    private readonly WebApplication app;
    private readonly object gate = new();
    private readonly Dictionary<Guid, List<SequencedUpdate>> projects = [];
    private readonly Dictionary<Guid, Guid> invitations = [];
    private readonly Dictionary<Guid, Guid> devices = [];
    private readonly Dictionary<string, Guid> accounts = [];
    private readonly Dictionary<Guid, Guid> owners = [];
    private readonly Dictionary<Guid, HashSet<Guid>> members = [];
    private readonly Dictionary<(Guid, Guid), HostedProjectDevice> projectDevices = [];
    internal Uri Address => new(app.Urls.Single());
    internal string? Reject { get; set; }
    internal TaskCompletionSource? Connecting { get; set; }
    internal bool KeyBoundEnrollment { get; set; }
    internal bool RejectRegistration { get; set; }
    internal List<Registration> Registrations { get; } = [];
    internal List<Registration> Rejected { get; } = [];

    private PersistentSessionServer(Uri authority)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        builder.Services.AddSingleton(this);
        builder.Services.AddSignalR(options => options.MaximumReceiveMessageSize = 4 * 1024 * 1024).AddMessagePackProtocol();
        app = builder.Build();
        app.MapGet("/client-configuration", () => new { protocolVersion = 1, authority = authority.AbsoluteUri, clientId = "novalist", scope = "openid profile sync offline_access", keyBoundEnrollment = KeyBoundEnrollment, accountIdentityReset = ResetSupported });
        app.MapGet("/devices/registration", async (HttpContext context) =>
        {
            if (Connecting is { } entered) { entered.TrySetResult(); await Task.Delay(Timeout.Infinite, context.RequestAborted); }
            return new { userId = Account(context), serverUrl = Address.AbsoluteUri };
        });
        app.MapPut("/devices/verified", (HttpContext context, Registration registration) =>
        {
            if (RejectRegistration)
            {
                lock (gate) Rejected.Add(registration);
                return Results.Problem(detail: "Injected refusal.", statusCode: StatusCodes.Status403Forbidden);
            }
            lock (gate)
            {
                devices[registration.Keys.DeviceId] = Account(context);
                Registrations.Add(registration);
            }
            return Results.Ok();
        });
        app.MapPost("/devices/enrollment", () => new { id = Guid.NewGuid(), nonce = Guid.NewGuid().ToString("N"), expiresAt = DateTimeOffset.UtcNow.AddMinutes(5) });
        MapIdentityResetEndpoints();
        app.MapHub<SessionHub>("/sync");
    }

    internal static async Task<PersistentSessionServer> StartAsync(Uri authority, CancellationToken ct)
    {
        var server = new PersistentSessionServer(authority);
        try { await server.app.StartAsync(ct); return server; }
        catch { await server.DisposeAsync(); throw; }
    }

    private Guid Account(HttpContext context)
    {
        var token = context.Request.Headers.Authorization.ToString();
        lock (gate)
        {
            if (!accounts.TryGetValue(token, out var account)) accounts[token] = account = Guid.NewGuid();
            return account;
        }
    }

    internal sealed record PublicKeys(Guid DeviceId, byte[] SigningPublicKey, byte[] ReceivingPublicKey);
    internal sealed record EnrollmentProof(Guid ChallengeId, string IdentityToken, byte[]? Salt);
    internal sealed record RecoveryRegistration(PublicKeys Keys);
    internal sealed record Registration(PublicKeys Keys, byte[] Signature, RecoveryRegistration? RecoveryDevice, EnrollmentProof? EnrollmentProof);
    public async ValueTask DisposeAsync() => await app.DisposeAsync();

    public sealed partial class SessionHub(PersistentSessionServer server) : Hub
    {
        private Guid Device => Guid.Parse(Context.GetHttpContext()!.Request.Query["deviceId"].ToString());
        private void Check(string operation)
        {
            if (server.Reject == operation) throw new HubException("Injected " + operation + " failure.");
        }

        public HostedDeviceChallenge GetDeviceChallenge()
        {
            lock (server.gate) return new(server.devices[Device], Device, Guid.NewGuid(), server.Address.AbsoluteUri);
        }
        public void AuthenticateDevice(byte[] signature)
        {
            if (signature.Length != 64) throw new HubException("Invalid proof.");
        }
        public void CreateProject(Guid project)
        {
            Check("create");
            lock (server.gate)
            {
                server.projects.TryAdd(project, []);
                server.owners.TryAdd(project, server.devices[Device]);
                server.members.TryAdd(project, [server.devices[Device]]);
            }
        }
        public HostedProjectEpoch GetProjectEpoch(Guid project)
        {
            lock (server.gate) return new(server.epochs.GetValueOrDefault(project), server.projects[project].Count);
        }
        public void RegisterProjectDevice(Guid project, uint epoch, byte[] certificate)
        {
            lock (server.gate) server.projectDevices[(project, Device)] = new(server.devices[Device], Device, epoch, certificate);
        }
        public async Task JoinProject(Guid project)
        {
            Check("join");
            lock (server.gate)
                if (!server.members.TryGetValue(project, out var group) || !group.Contains(server.devices[Device])) throw new HubException("Access ended.");
            await Groups.AddToGroupAsync(Context.ConnectionId, project.ToString("N"));
        }
        public async Task<long> Push(UpdateEnvelope envelope)
        {
            Check("push");
            var header = UpdateHeader.Parse(envelope.Header);
            SequencedUpdate update;
            lock (server.gate)
            {
                if (server.reservations.Values.Any(value => value.Project == header.ProjectId)) throw new HubException(HostedProtocol.TransitionInProgress);
                var history = server.projects[header.ProjectId];
                if (history.FirstOrDefault(item => item.Envelope.Header.AsSpan().SequenceEqual(envelope.Header)) is { } previous) return previous.ServerSeq;
                update = new(history.Count + 1, envelope);
                history.Add(update);
            }
            await Clients.Group(header.ProjectId.ToString("N")).SendAsync("ReceiveUpdate", update);
            return update.ServerSeq;
        }
        public async IAsyncEnumerable<SequencedUpdate> CatchUp(Guid project, long after, [EnumeratorCancellation] CancellationToken ct)
        {
            SequencedUpdate[] updates;
            lock (server.gate)
            {
                if (after < server.HistoryStart(project) - 1) throw new HubException(HostedProtocol.HistoryReplaced);
                updates = server.projects[project].Where(update => update.ServerSeq > after).ToArray();
            }
            foreach (var update in updates) { ct.ThrowIfCancellationRequested(); yield return update; }
            await Task.CompletedTask;
        }
        public Task PublishPresence(UpdateEnvelope envelope) => Clients.Group(UpdateHeader.Parse(envelope.Header, EnvelopeKind.Presence).ProjectId.ToString("N"))
            .SendAsync("ReceivePresence", envelope);
        public void CreateInvitation(Guid project, HostedInvitationRequest request)
        {
            lock (server.gate) server.invitations.Add(request.InvitationId, project);
        }
        public HostedInvitationActivation ActivateInvitation(HostedInvitationActivationRequest request)
        {
            Check("activate");
            lock (server.gate)
            {
                var project = server.invitations[request.InvitationId];
                server.members[project].Add(server.devices[Device]);
                return new(project, Device, request.CertificateHash);
            }
        }
    }
}
