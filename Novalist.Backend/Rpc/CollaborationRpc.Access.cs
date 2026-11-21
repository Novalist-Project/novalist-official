#if NOVALIST_COLLABORATION
using Novalist.Sync.Client;
using StreamJsonRpc;

namespace Novalist.Backend.Rpc;

public sealed partial class CollaborationRpc
{
    [JsonRpcMethod("collaboration/members")]
    public Task<IReadOnlyList<HostedProjectMember>> MembersAsync(CancellationToken cancellationToken = default) =>
        workspace.HostedProjects?.IsActive == true ? Hosted().MembersAsync(cancellationToken) : Task.FromResult(Peers().Members());

    [JsonRpcMethod("collaboration/removeMember")]
    public Task RemoveMemberAsync(Guid memberId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (workspace.HostedProjects?.IsActive == true) return Hosted().RemoveMemberAsync(memberId, cancellationToken);
        Peers().RemoveMember(memberId);
        return Task.CompletedTask;
    }

    [JsonRpcMethod("collaboration/deleteSharedProject")]
    public Task DeleteSharedProjectAsync(CancellationToken cancellationToken = default) =>
        workspace.HostedProjects?.IsActive == true ? Hosted().DeleteSharedProjectAsync(cancellationToken) : Peers().DeleteSharedProjectAsync();
}
#endif
