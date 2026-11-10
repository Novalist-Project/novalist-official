using Novalist.Core.Models;
using StreamJsonRpc;

namespace Novalist.Backend.Rpc;

public sealed class WritingRpc(Workspace workspace)
{
    [JsonRpcMethod("writing/commit")]
    public Task<WritingCommitResult> CommitAsync(WritingCommitRequest request)
        => new WritingMutationCoordinator(workspace).CommitAsync(request);
}
