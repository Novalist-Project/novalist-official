using Microsoft.AspNetCore.SignalR;
using Novalist.Sync.Client;

namespace Novalist.Backend.Tests.TestHelpers;

internal sealed partial class PersistentSessionServer
{
    private readonly Dictionary<Guid, HistoryBoundary> histories = [];
    private readonly Dictionary<Guid, List<UpdateEnvelope>> compactions = [];
    private sealed record HistoryBoundary(long Start, long CheckpointBytes, DateTimeOffset CompactedAt);
    // Servers before history compaction do not know the method at all.
    internal bool HistoryUnsupported { get; set; }
    internal int Compactions { get; private set; }
    // Reports a reserved position that differs from the log, as if the log moved before the capture.
    internal long ReservedSequenceShift { get; set; }

    private long HistoryStart(Guid project) => histories.TryGetValue(project, out var boundary) ? boundary.Start : 1;
    private static long Size(UpdateEnvelope envelope) => envelope.Header.Length + envelope.Nonce.Length + envelope.Ciphertext.Length + envelope.Signature.Length;

    public sealed partial class SessionHub
    {
        public HostedProjectHistory GetProjectHistory(Guid project)
        {
            if (server.HistoryUnsupported) throw new HubException("Method does not exist.");
            lock (server.gate)
            {
                var start = server.HistoryStart(project);
                var history = server.projects[project];
                var boundary = server.histories.GetValueOrDefault(project);
                return new(start, history.Count, history.Where(update => update.ServerSeq >= start).Sum(update => Size(update.Envelope)),
                    boundary?.CheckpointBytes, boundary?.CompactedAt);
            }
        }
        public HostedProjectEpoch ReserveProjectCompaction(Guid project, Guid compaction)
        {
            Check("compact");
            lock (server.gate)
            {
                if (server.reservations.Values.Any(value => value.Project == project)) throw new HubException("Another transition is already reserved.");
                var sequence = server.projects[project].Count;
                server.reservations.Add(compaction, (project, Device, sequence));
                server.compactions.Add(compaction, []);
                return new(server.epochs.GetValueOrDefault(project), sequence + server.ReservedSequenceShift);
            }
        }
        public long StageProjectCompaction(Guid compaction, UpdateEnvelope envelope)
        {
            lock (server.gate)
            {
                var staged = server.compactions[compaction];
                staged.Add(envelope);
                return staged.Count;
            }
        }
        public async Task CommitProjectCompaction(Guid compaction)
        {
            Check("commitCompaction");
            Guid project;
            long start;
            lock (server.gate)
            {
                var reservation = server.reservations[compaction];
                project = reservation.Project;
                var history = server.projects[project];
                if (history.Count != reservation.Sequence) throw new HubException("The project changed during compaction.");
                start = reservation.Sequence + 1;
                foreach (var envelope in server.compactions[compaction]) history.Add(new(history.Count + 1, envelope));
                server.histories[project] = new(start, server.compactions[compaction].Sum(Size), DateTimeOffset.UtcNow);
                server.reservations.Remove(compaction);
                server.compactions.Remove(compaction);
                server.Compactions++;
            }
            await Clients.Group(project.ToString("N")).SendAsync("ProjectHistoryCompacted", project, start);
        }
        public void CancelProjectCompaction(Guid compaction)
        {
            lock (server.gate) { server.reservations.Remove(compaction); server.compactions.Remove(compaction); }
        }
    }
}
