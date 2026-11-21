using System.Text;
using System.IO.Enumeration;

namespace Novalist.Core.Services;

internal sealed class StagedFileService(IFileService source) : IFileService
{
    private readonly Dictionary<string, WritingFileMutation> changes = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string> reads = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> directories = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> removedDirectories = new(StringComparer.OrdinalIgnoreCase);
    internal WritingFileMutation[] Changes => changes.Values.Where(change => change.Before != change.After).ToArray();
    private static string Key(string path) => Path.GetFullPath(path);
    public async Task<string> ReadTextAsync(string path)
    {
        path = Key(path);
        if (changes.TryGetValue(path, out var change)) return change.After ?? throw new FileNotFoundException("The staged file was removed.");
        if (reads.TryGetValue(path, out var content)) return content;
        return reads[path] = await source.ReadTextAsync(path);
    }
    public async Task WriteTextAsync(string path, string content) => await SetAsync(path, content);
    private async Task SetAsync(string path, string? content)
    {
        path = Key(path);
        var before = changes.TryGetValue(path, out var existing) ? existing.Before
            : await source.ExistsAsync(path) ? await ReadTextAsync(path) : null;
        changes[path] = new(path, before, content);
        if (content is not null && Path.GetDirectoryName(path) is { } parent) await CreateDirectoryAsync(parent);
    }
    public async Task<byte[]> ReadBytesAsync(string path) => Encoding.UTF8.GetBytes(await ReadTextAsync(path));
    public Task WriteBytesAsync(string path, byte[] bytes) => WriteTextAsync(path, new UTF8Encoding(false, true).GetString(bytes));
    public Task<bool> ExistsAsync(string path) => changes.TryGetValue(Key(path), out var change) ? Task.FromResult(change.After is not null) : source.ExistsAsync(path);
    public async Task<bool> DirectoryExistsAsync(string path) => directories.Contains(Key(path)) || !Removed(path) && await source.DirectoryExistsAsync(path);
    public Task CreateDirectoryAsync(string path)
    {
        for (string? current = Key(path); current is not null; current = Path.GetDirectoryName(current)) { directories.Add(current); removedDirectories.Remove(current); }
        return Task.CompletedTask;
    }
    public async Task<IReadOnlyList<string>> GetFilesAsync(string directory, string pattern = "*", bool recursive = false)
    {
        directory = Key(directory);
        var existing = !Removed(directory) && await source.DirectoryExistsAsync(directory) ? await source.GetFilesAsync(directory, pattern, recursive) : [];
        bool Inside(string path) => recursive ? path.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            : string.Equals(Path.GetDirectoryName(path), directory, StringComparison.OrdinalIgnoreCase);
        return existing.Concat(changes.Keys.Where(Inside).Where(path => FileSystemName.MatchesSimpleExpression(pattern, Path.GetFileName(path), true)))
            .Distinct(StringComparer.OrdinalIgnoreCase).Where(path => !changes.TryGetValue(Key(path), out var change) || change.After is not null).ToArray();
    }
    public async Task<IReadOnlyList<string>> GetDirectoriesAsync(string directory)
        => (await source.DirectoryExistsAsync(directory) ? await source.GetDirectoriesAsync(directory) : [])
            .Concat(directories.Where(path => string.Equals(Path.GetDirectoryName(path), Key(directory), StringComparison.OrdinalIgnoreCase)))
            .Distinct(StringComparer.OrdinalIgnoreCase).Where(path => !Removed(path)).ToArray();
    public Task DeleteFileAsync(string path) => SetAsync(path, null);
    public async Task DeleteDirectoryAsync(string path, bool recursive = true)
    {
        foreach (var file in await GetFilesAsync(path, "*", recursive)) await DeleteFileAsync(file);
        directories.RemoveWhere(directory => directory.Equals(Key(path), StringComparison.OrdinalIgnoreCase) || directory.StartsWith(Key(path) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));
        removedDirectories.Add(Key(path));
    }
    public async Task MoveFileAsync(string oldPath, string newPath)
    {
        if (await ExistsAsync(newPath)) throw new IOException("The destination file exists.");
        await WriteTextAsync(newPath, await ReadTextAsync(oldPath));
        await DeleteFileAsync(oldPath);
    }
    public async Task MoveDirectoryAsync(string oldPath, string newPath)
    {
        foreach (var file in await GetFilesAsync(oldPath, "*", true)) await MoveFileAsync(file, Path.Combine(newPath, Path.GetRelativePath(oldPath, file)));
        await DeleteDirectoryAsync(oldPath);
    }
    public async Task<long> GetFileSizeAsync(string path) => (await ReadBytesAsync(path)).LongLength;
    public Task<DateTime> GetLastWriteTimeUtcAsync(string path) => changes.ContainsKey(Key(path)) ? Task.FromResult(DateTime.UnixEpoch) : source.GetLastWriteTimeUtcAsync(path);
    public string CombinePath(params string[] parts) => source.CombinePath(parts);
    public string GetFileName(string path) => source.GetFileName(path);
    public string GetFileNameWithoutExtension(string path) => source.GetFileNameWithoutExtension(path);
    public string GetDirectoryName(string path) => source.GetDirectoryName(path);
    private bool Removed(string path) => removedDirectories.Any(directory => Key(path).Equals(directory, StringComparison.OrdinalIgnoreCase)
        || Key(path).StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase));
}
