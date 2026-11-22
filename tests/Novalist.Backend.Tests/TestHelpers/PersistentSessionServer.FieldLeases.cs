using Microsoft.AspNetCore.SignalR;
using Novalist.Sync.Client;

namespace Novalist.Backend.Tests.TestHelpers;

internal sealed partial class PersistentSessionServer
{
    private readonly Dictionary<(Guid Project, Guid Resource), (Guid Device, Guid Lease, DateTimeOffset Expires)> fieldLeases = [];

    public sealed partial class SessionHub
    {
        public DateTimeOffset GetFieldLeaseTime() => DateTimeOffset.UtcNow;

        public FieldLeaseGrant AcquireFieldLease(FieldLeaseRequest request)
        {
            var now = DateTimeOffset.UtcNow;
            lock (server.gate)
            {
                var key = (request.ProjectId, request.ResourceId);
                if (server.fieldLeases.TryGetValue(key, out var held) && held.Expires > now && held.Device != Device)
                    return new(held.Device, held.Lease, held.Expires, now, server.projects[request.ProjectId].Count);
                server.fieldLeases[key] = (Device, request.LeaseId, now.AddSeconds(20));
                return new(Device, request.LeaseId, now.AddSeconds(20), now, server.projects[request.ProjectId].Count);
            }
        }

        public FieldLeaseGrant? RenewFieldLease(FieldLeaseRequest request)
        {
            lock (server.gate)
                return server.fieldLeases.TryGetValue((request.ProjectId, request.ResourceId), out var held) && held.Lease == request.LeaseId
                    ? AcquireFieldLease(request) : null;
        }

        public bool ReleaseFieldLease(FieldLeaseRequest request)
        {
            lock (server.gate)
                return server.fieldLeases.TryGetValue((request.ProjectId, request.ResourceId), out var held) && held.Lease == request.LeaseId &&
                    server.fieldLeases.Remove((request.ProjectId, request.ResourceId));
        }

        public Task<long> PushFieldEdit(FieldLeaseRequest request, UpdateEnvelope envelope)
        {
            lock (server.gate)
                if (!server.fieldLeases.TryGetValue((request.ProjectId, request.ResourceId), out var held) || held.Lease != request.LeaseId)
                    throw new HubException("The field editing lease is not held.");
            return Push(envelope);
        }

        public Task<long> PushGuardedFieldEdit(FieldLeaseRequest request, FieldLeaseRequest required, UpdateEnvelope envelope) =>
            PushFieldEdit(required, envelope);
    }
}
