using Novalist.Mobile.Services;
using Xunit;

namespace Novalist.Core.Tests;

public class MobileCallbackWatchdogTests
{
    [Fact]
    public async Task ACallbackAlreadyInFlightCanStillBeAcknowledgedAfterThePickerReturns()
    {
        var timeout = TimeSpan.FromMilliseconds(200);
        var watchdog = new MobileCallbackWatchdog(timeout);
        var response = new TaskCompletionSource<string>();
        var pending = watchdog.WaitAsync(response.Task, CancellationToken.None);
        watchdog.SetForeground(false);

        var foreground = new MobileCallbackWatchdog(timeout);
        await Assert.ThrowsAsync<TimeoutException>(() => foreground.WaitAsync(
            new TaskCompletionSource<string>().Task, CancellationToken.None));
        Assert.False(pending.IsCompleted);
        watchdog.SetForeground(true);
        response.SetResult("accepted");
        Assert.Equal("accepted", await pending);
    }

    [Fact]
    public async Task ACallbackStartedInTheBackgroundGetsAForegroundDeadlineOnReturn()
    {
        var watchdog = new MobileCallbackWatchdog(TimeSpan.Zero);
        watchdog.SetForeground(false);
        var pending = watchdog.WaitAsync(new TaskCompletionSource<string>().Task, CancellationToken.None);
        Assert.False(pending.IsCompleted);
        watchdog.SetForeground(true);
        await Assert.ThrowsAsync<TimeoutException>(() => pending);
    }

    [Fact]
    public async Task ClosingThePageCancelsAHiddenCallback()
    {
        var watchdog = new MobileCallbackWatchdog(TimeSpan.Zero);
        watchdog.SetForeground(false);
        using var closing = new CancellationTokenSource();
        var pending = watchdog.WaitAsync(new TaskCompletionSource<string>().Task, closing.Token);
        closing.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
    }
}
