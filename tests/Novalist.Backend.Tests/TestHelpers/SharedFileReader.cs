using System.Text;

namespace Novalist.Backend.Tests.TestHelpers;

/// <summary>
/// Reads files the product may be writing while a test polls them. The product
/// replaces files by moving a finished temporary copy over them, so a reader
/// that shares read, write and delete access never blocks that move, and a file
/// that is missing or locked at this instant simply is not there yet.
/// </summary>
public static class SharedFileReader
{
    public static string? TryReadText(string path)
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            return reader.ReadToEnd();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public static bool Contains(string path, string text)
        => TryReadText(path)?.Contains(text, StringComparison.Ordinal) == true;

    /// <summary>Every file under a directory that holds the text; empty while the directory or its files are not readable yet.</summary>
    public static string[] FilesContaining(string directory, string text)
    {
        try
        {
            return Directory.Exists(directory)
                ? [.. Directory.GetFiles(directory, "*", SearchOption.AllDirectories).Where(file => Contains(file, text))]
                : [];
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    /// <summary>Waits up to the shared test deadline for the file to hold the text; see the overload for what is returned.</summary>
    public static Task<string> WaitForTextAsync(string path, string text, CancellationToken cancellationToken)
    {
        var delay = TimeSpan.FromMilliseconds(20);
        return WaitForTextAsync(path, text, (int)(TestWait.Deadline / delay), delay, cancellationToken);
    }

    /// <summary>Polls until the file holds the text, then returns what was last read so a timeout can say what arrived instead.</summary>
    public static async Task<string> WaitForTextAsync(string path, string text, int attempts, TimeSpan delay, CancellationToken cancellationToken)
    {
        var last = TryReadText(path);
        for (var attempt = 0; attempt < attempts && last?.Contains(text, StringComparison.Ordinal) != true; attempt++)
        {
            await Task.Delay(delay, cancellationToken);
            last = TryReadText(path);
        }
        return last ?? "<file missing or locked>";
    }
}
