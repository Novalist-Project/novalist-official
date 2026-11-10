using System.Text;
using Novalist.Backend.Extensions;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed partial class AudiobookRpcTests
{
    [Fact]
    public async Task CompletedRenderCanRestartBeforeItsDiagnosticWriteReturns()
    {
        await ChapterAsync("One", "<p>Hello there.</p>");
        await CastNarratorAsync();
        _engine.Ready = true;
        var previousError = Console.Error;
        var previousVerbose = Log.Verbose;
        using var release = new ManualResetEventSlim();
        var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var restarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task? starting = null;
        Task? restarting = null;
        Console.SetError(new CompletionWriter(previousError, completed, release));
        Log.Verbose = true;
        try
        {
            starting = Task.Run(() => _rpc.StartAsync("WavPerChapter", Output));
            await completed.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal("done", _rpc.Status().Phase);
            _engine.Started = restarted;
            restarting = Task.Run(() => _rpc.StartAsync("WavPerChapter", Output, fromScratch: true));

            await restarted.Task.WaitAsync(TimeSpan.FromSeconds(5));

            Assert.Equal(2, _engine.Renders);
        }
        finally
        {
            release.Set();
            if (starting is not null) await starting;
            if (restarting is not null) await restarting;
            await SettledAsync();
            Console.SetError(previousError);
            Log.Verbose = previousVerbose;
        }
    }

    private sealed class CompletionWriter(TextWriter output, TaskCompletionSource completed, ManualResetEventSlim release) : TextWriter
    {
        public override Encoding Encoding => output.Encoding;

        public override void WriteLine(string? value)
        {
            if (value?.StartsWith("[INFO] audiobook rendered", StringComparison.Ordinal) == true)
            {
                completed.TrySetResult();
                if (!release.Wait(TimeSpan.FromSeconds(15))) throw new TimeoutException("Completion log was not released.");
            }
            output.WriteLine(value);
        }
    }
}
