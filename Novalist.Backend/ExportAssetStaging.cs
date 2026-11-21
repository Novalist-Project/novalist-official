using Novalist.Backend.Extensions;
using Novalist.Core.Services;

namespace Novalist.Backend;

internal sealed class ExportAssetStaging(IFileService files, int cleanupAttempts = 10, int cleanupDelayMilliseconds = 100) : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "novalist-export-" + Guid.NewGuid().ToString("N"));
    private readonly Dictionary<string, string> _paths = new(StringComparer.Ordinal);

    public async Task<string> MaterializeAsync(string path)
    {
        if (!Path.IsPathFullyQualified(path)) return path;
        var source = Path.GetFullPath(path);
        if (File.Exists(source)) return source;
        if (_paths.TryGetValue(source, out var staged)) return staged;
        if (!await files.ExistsAsync(source)) return source;
        var bytes = await files.ReadBytesAsync(source);
        var directory = Path.Combine(_directory, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var destination = Path.Combine(directory, Path.GetFileName(source));
        await File.WriteAllBytesAsync(destination, bytes);
        _paths.Add(source, destination);
        return destination;
    }

    /// <summary>
    /// Removes the staging folder. The export has already been written by now,
    /// so a file that something outside the export still holds (a virus scanner
    /// or indexer, typically) is retried briefly and then left for the
    /// operating system's temp cleanup instead of failing the export.
    /// </summary>
    public void Dispose()
    {
        for (var attempt = 1; Directory.Exists(_directory); attempt++)
        {
            try
            {
                Directory.Delete(_directory, true);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                if (attempt >= cleanupAttempts)
                {
                    Log.Warn($"Export staging folder left for temp cleanup: {exception.GetType().Name}");
                    return;
                }
                Thread.Sleep(cleanupDelayMilliseconds);
            }
        }
    }
}
