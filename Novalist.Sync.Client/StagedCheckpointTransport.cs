using System.Runtime.CompilerServices;

namespace Novalist.Sync.Client;

// Publishes a checkpoint into a server reservation instead of the live log. Nothing is received or caught up:
// the staged journal holds only what this device uploads.
internal sealed class StagedCheckpointTransport(HostedTransport hosted, string stage, Func<UpdateEnvelope, CancellationToken, Task<long>> push) : IUpdateTransport
{
    public event Func<SequencedUpdate, Task>? Received { add { } remove { } }
    public bool IsConnected => hosted.IsConnected;
    public string ConnectionIdentity => hosted.ConnectionIdentity + "/" + stage;
    public Task ConnectAsync(CancellationToken ct) => Task.CompletedTask;
    public Task CreateProjectAsync(Guid project, CancellationToken ct) => throw new InvalidOperationException("A transition cannot create a project.");
    public Task JoinAsync(Guid project, CancellationToken ct) => Task.CompletedTask;
    public Task<long> PushAsync(UpdateEnvelope envelope, CancellationToken ct) => push(envelope, ct);
    public async IAsyncEnumerable<SequencedUpdate> CatchUpAsync(Guid project, long after, [EnumeratorCancellation] CancellationToken ct)
    { ct.ThrowIfCancellationRequested(); await Task.CompletedTask; yield break; }
    public Task DisconnectAsync(CancellationToken ct) => Task.CompletedTask;
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
