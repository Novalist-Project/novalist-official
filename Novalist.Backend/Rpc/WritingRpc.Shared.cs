using Novalist.Core.Models;
using Novalist.Core.Services;
using StreamJsonRpc;

namespace Novalist.Backend.Rpc;

public sealed partial class WritingRpc
{
    [JsonRpcMethod("writing/commitSharedAnnotations")]
    public Task<WritingSharedAnnotationResult> CommitSharedAnnotationsAsync(WritingSharedAnnotationRequest request)
    {
#if NOVALIST_COLLABORATION
        return workspace.CommitSharedWritingAnnotationsAsync(request);
#else
        return Task.FromResult(new WritingSharedAnnotationResult("retryable", WritingOperationJournal.OperationId(request.TransactionId), ErrorCode: "writing.sharedUnavailable"));
#endif
    }
}
