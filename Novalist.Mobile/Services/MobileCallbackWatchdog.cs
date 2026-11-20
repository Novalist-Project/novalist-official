namespace Novalist.Mobile.Services;

internal sealed class MobileCallbackWatchdog(TimeSpan timeout)
{
    private readonly object _gate = new();
    private readonly HashSet<CancellationTokenSource> _pending = [];
    private bool _foreground = true;

    internal void SetForeground(bool foreground)
    {
        lock (_gate)
        {
            if (_foreground == foreground) return;
            _foreground = foreground;
            foreach (var deadline in _pending)
                deadline.CancelAfter(foreground ? timeout : Timeout.InfiniteTimeSpan);
        }
    }

    internal async Task<T> WaitAsync<T>(Task<T> callback, CancellationToken cancellationToken)
    {
        if (callback.IsCompleted) return await callback.ConfigureAwait(false);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        lock (_gate)
        {
            _pending.Add(deadline);
            if (_foreground) deadline.CancelAfter(timeout);
        }
        try { return await callback.WaitAsync(deadline.Token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (deadline.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException("The editor did not acknowledge its response in the foreground.");
        }
        finally { lock (_gate) _pending.Remove(deadline); }
    }
}
