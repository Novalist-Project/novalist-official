namespace Novalist.Backend;

public sealed partial class Workspace
{
    private WritingFocus? _writingFocus;

    internal void SetWritingFocus(string owner, string sourceId, long epoch, long generation)
    {
        if (WorkspaceRequestContext.Identity?.Owner != "0")
            throw new InvalidOperationException("Only the window coordinator can set writing focus.");
        if (epoch != (Coordinator?.Epoch ?? 0) || generation < 0)
            throw new InvalidOperationException("The writing focus request is obsolete.");
        if (_writingFocus is { } current && current.Epoch == epoch && generation <= current.Generation) return;
        _writingFocus = new(owner, sourceId, epoch, generation);
    }

    internal bool AcceptWritingActivation(string sourceId, long epoch, long focusGeneration, long activationGeneration)
    {
        var identity = WorkspaceRequestContext.Identity;
        if (_writingFocus is not { } focus || identity is null
            || epoch != (Coordinator?.Epoch ?? 0) || identity.Epoch != epoch
            || focus.Epoch != epoch || focus.Owner != identity.Owner || focus.SourceId != sourceId
            || focus.Generation != focusGeneration || activationGeneration <= focus.ActivationGeneration)
            return false;
        focus.ActivationGeneration = activationGeneration;
        return true;
    }

    private sealed record WritingFocus(string Owner, string SourceId, long Epoch, long Generation)
    {
        internal long ActivationGeneration { get; set; } = -1;
    }
}
