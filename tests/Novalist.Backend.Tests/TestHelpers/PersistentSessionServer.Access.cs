using Microsoft.AspNetCore.SignalR;
using Novalist.Sync.Client;

namespace Novalist.Backend.Tests.TestHelpers;

internal sealed partial class PersistentSessionServer
{
    private readonly Dictionary<Guid, uint> epochs = [];
    private readonly Dictionary<Guid, Rotation> rotations = [];
    private readonly Dictionary<(Guid, Guid), StoredHostedEpochGrant> grants = [];
    private readonly Dictionary<Guid, (Guid Project, Guid Device, long Sequence)> reservations = [];
    private sealed record Rotation(BeginHostedEpoch Begin, Guid Grantor, List<SequencedUpdate> Updates, List<HostedEpochGrant> Grants);

    public sealed partial class SessionHub
    {
        public IReadOnlyList<HostedProjectMember> ListProjectMembers(Guid project)
        {
            lock (server.gate) return server.members[project].Select(user => new HostedProjectMember(user, user.ToString("N"),
                server.owners[project] == user ? "Owner" : "Contributor")).ToArray();
        }
        public IReadOnlyList<HostedProjectDevice> ListProjectDevices(Guid project)
        {
            lock (server.gate) return server.projectDevices.Where(pair => pair.Key.Item1 == project).Select(pair => pair.Value).ToArray();
        }
        public async Task DeleteProject(Guid project)
        {
            lock (server.gate) { server.members.Remove(project); server.projects.Remove(project); }
            await Clients.Group(project.ToString("N")).SendAsync("ProjectAccessEnded", project);
        }
        public HostedProjectEpoch ReserveProjectEpoch(Guid project, Guid rotation)
        {
            lock (server.gate)
            {
                if (server.reservations.Values.Any(value => value.Project == project)) throw new HubException("A rotation is already reserved.");
                var sequence = server.projects[project].Count;
                server.reservations.Add(rotation, (project, Device, sequence));
                return new(server.epochs.GetValueOrDefault(project), sequence);
            }
        }
        public void CancelProjectEpoch(Guid rotation)
        {
            lock (server.gate) { server.rotations.Remove(rotation); server.reservations.Remove(rotation); }
        }
        public void BeginProjectEpoch(BeginHostedEpoch request)
        {
            lock (server.gate)
            {
                var reservation = server.reservations[request.RotationId];
                if (reservation.Project != request.ProjectId || reservation.Device != Device || reservation.Sequence != request.PreviousServerSeq)
                    throw new HubException("The rotation boundary changed.");
                server.rotations.Add(request.RotationId, new(request, Device, [], []));
            }
        }
        public long StageProjectEpoch(Guid rotationId, UpdateEnvelope envelope)
        {
            Check("stage");
            lock (server.gate)
            {
                var rotation = server.rotations[rotationId];
                var sequence = rotation.Begin.PreviousServerSeq + rotation.Updates.Count + 1;
                rotation.Updates.Add(new(sequence, envelope));
                return sequence;
            }
        }
        public void StageProjectEpochGrant(Guid rotationId, HostedEpochGrant grant)
        {
            lock (server.gate) server.rotations[rotationId].Grants.Add(grant);
        }
        public async Task CommitProjectEpoch(CommitHostedEpoch request)
        {
            Guid project;
            uint epoch;
            lock (server.gate)
            {
                var rotation = server.rotations[request.RotationId];
                project = rotation.Begin.ProjectId;
                epoch = server.epochs[project] = rotation.Begin.PreviousEpoch + 1;
                server.projects[project].AddRange(rotation.Updates);
                if (request.RemovedMemberId is { } removedMember) server.members[project].Remove(removedMember);
                foreach (var grant in rotation.Grants)
                {
                    server.grants[(project, grant.DeviceId)] = new(epoch, rotation.Begin.PreviousServerSeq + 1, rotation.Grantor, grant.Payload);
                    server.projectDevices[(project, grant.DeviceId)] = server.projectDevices[(project, grant.DeviceId)] with { Epoch = epoch, Certificate = grant.Certificate };
                }
                foreach (var removed in server.projectDevices.Where(pair => pair.Key.Item1 == project && pair.Value.UserId == request.RemovedMemberId).Select(pair => pair.Key).ToArray())
                    server.projectDevices.Remove(removed);
                server.reservations.Remove(request.RotationId);
            }
            await Clients.Group(project.ToString("N")).SendAsync("ProjectEpochChanged", project, epoch);
        }
        public StoredHostedEpochGrant? GetProjectEpochGrant(Guid project, uint afterEpoch)
        {
            lock (server.gate)
            {
                var grant = server.grants.GetValueOrDefault((project, Device));
                return grant?.Epoch > afterEpoch ? grant : null;
            }
        }
    }
}
