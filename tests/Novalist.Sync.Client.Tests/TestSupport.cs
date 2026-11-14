namespace Novalist.Tests.Support;

/// <summary>
/// The one place tests decide how long to wait for something that happens on
/// another thread, process or socket.
/// </summary>
/// <remarks>
/// A deadline is a hang detector, not a performance assertion: it costs nothing
/// while the condition is met promptly and only matters when the test is going
/// to fail anyway. It therefore has to be far longer than a loaded CI runner can
/// stall a test (CPU contention, a debugger-less thread pool starved by sibling
/// test classes), which is why it is a minute rather than the few seconds that
/// each test used to pick for itself. Prefer awaiting the actual signal with
/// <c>task.WaitAsync(TestWait.Deadline, ct)</c>; poll with
/// <see cref="UntilAsync(Func{bool}, string, CancellationToken)"/> only when the
/// product offers no event to wait on.
/// </remarks>
internal static class TestWait
{
    public static readonly TimeSpan Deadline = TimeSpan.FromSeconds(60);

    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(10);

    /// <summary>Polls until the condition holds, failing with a message that names what never happened.</summary>
    public static Task UntilAsync(Func<bool> condition, string description, CancellationToken cancellationToken = default)
        => UntilAsync(() => Task.FromResult(condition()), description, cancellationToken);

    /// <summary>Polls an asynchronous condition until it holds, failing with a message that names what never happened.</summary>
    public static async Task UntilAsync(Func<Task<bool>> condition, string description, CancellationToken cancellationToken = default)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(Deadline);
        try
        {
            while (!await condition().ConfigureAwait(false))
                await Task.Delay(PollInterval, deadline.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException($"Gave up after {Deadline.TotalSeconds:0}s waiting for {description}.");
        }
    }
}

/// <summary>Clean-up that must never be the reason a test fails.</summary>
internal static class TestFiles
{
    /// <summary>
    /// Deletes a scratch tree, giving a handle the product or the OS is still
    /// letting go of (a closing database, a virus scanner) a moment to release.
    /// Whatever cannot be removed is left to the temp folder: the assertions
    /// already ran, and a locked leftover says nothing about the behaviour under test.
    /// </summary>
    public static void DeleteTree(string path)
    {
        for (var attempt = 0; attempt < 5 && Directory.Exists(path); attempt++)
        {
            try
            {
                Directory.Delete(path, recursive: true);
                return;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                Thread.Sleep(50);
            }
        }
    }
}
