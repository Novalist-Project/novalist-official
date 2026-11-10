using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using Novalist.Core.Models;

namespace Novalist.Core.Services;

public sealed class WritingOperationJournal
{
    private readonly string _root;
    private readonly string _directory;
    private readonly IFileService _files;

    public WritingOperationJournal(string projectRoot, IFileService files)
    {
        _root = Path.GetFullPath(projectRoot);
        _directory = Path.Combine(_root, ".novalist", "writing-operations");
        _files = files;
    }

    public async Task<WritingOperation?> FindAsync(string transactionId, string fingerprint)
    {
        var id = OperationId(transactionId);
        var path = JournalPath(id);
        if (!await _files.ExistsAsync(path)) return null;
        var operation = await ReadAsync(path);
        if (operation.TransactionId != transactionId || operation.Fingerprint != fingerprint)
            throw new InvalidOperationException("The transaction identifier was already used for different edits.");
        return operation;
    }

    public async Task<WritingOperation> PrepareAsync(string transactionId, string fingerprint,
        IReadOnlyList<WritingFileMutation> mutations, CancellationToken ct = default, WritingSceneHash[]? hashes = null)
    {
        ct.ThrowIfCancellationRequested();
        ArgumentException.ThrowIfNullOrWhiteSpace(transactionId);
        var changes = mutations.Select(mutation => mutation with { Path = RelativePath(mutation.Path) }).ToArray();
        if (changes.Length == 0 || changes.Select(change => change.Path).Distinct(StringComparer.OrdinalIgnoreCase).Count() != changes.Length)
            throw new InvalidDataException("A writing operation requires distinct affected files.");
        var existing = await FindAsync(transactionId, fingerprint);
        if (existing?.State == "committed") return existing;
        if (existing?.State == "prepared") await RollbackAsync(existing);
        await ValidateBeforeAsync(changes, ct);
        var operation = new WritingOperation(OperationId(transactionId), transactionId, fingerprint, "prepared", changes) { Hashes = hashes ?? [] };
        await _files.CreateDirectoryAsync(_directory);
        await SaveAsync(operation);
        return operation;
    }

    public async Task CommitAsync(WritingOperation operation, CancellationToken ct = default)
    {
        operation = await ReadAsync(JournalPath(operation.OperationId));
        if (operation.State == "committed") return;
        if (operation.State != "prepared") throw new InvalidOperationException("Prepare the retained operation before retrying.");
        await ValidateBeforeAsync(operation.Files, ct);
        try
        {
            foreach (var change in operation.Files)
            {
                ct.ThrowIfCancellationRequested();
                var path = Resolve(change.Path);
                if (await ReadOptionalAsync(path) != change.Before)
                    throw new IOException("A writing file changed during commit.");
                await WriteOptionalAsync(path, change.After);
            }
            await SaveAsync(operation with { State = "committed" });
        }
        catch
        {
            await RollbackAsync(operation);
            throw;
        }
    }

    public async Task RollbackAsync(WritingOperation operation)
    {
        operation = await ReadAsync(JournalPath(operation.OperationId));
        if (operation.State == "committed") return;
        var conflicted = false;
        foreach (var change in operation.Files.Reverse())
        {
            var path = Resolve(change.Path);
            var current = await ReadOptionalAsync(path);
            if (current == change.Before) continue;
            if (current != change.After)
            {
                conflicted = true;
                continue;
            }
            await WriteOptionalAsync(path, change.Before);
        }
        if (conflicted) throw new IOException("Recovery retained an affected file with newer changes.");
        await SaveAsync(operation with { State = "rolledBack" });
    }

    public async Task RecoverAsync(CancellationToken ct = default)
    {
        if (!await _files.DirectoryExistsAsync(_directory)) return;
        foreach (var path in await _files.GetFilesAsync(_directory, "*.json"))
        {
            ct.ThrowIfCancellationRequested();
            var operation = await ReadAsync(path);
            if (operation.State == "prepared") await RollbackAsync(operation);
        }
    }

    private async Task ValidateBeforeAsync(IEnumerable<WritingFileMutation> changes, CancellationToken ct)
    {
        foreach (var change in changes)
        {
            ct.ThrowIfCancellationRequested();
            if (await ReadOptionalAsync(Resolve(change.Path)) != change.Before)
                throw new IOException("An affected writing file changed before commit.");
        }
    }

    private async Task<WritingOperation> ReadAsync(string path)
    {
        var operation = JsonSerializer.Deserialize<WritingOperation>(await _files.ReadTextAsync(path))
            ?? throw new InvalidDataException("Invalid writing recovery record.");
        if (operation.OperationId != OperationId(operation.TransactionId)
            || !string.Equals(Path.GetFullPath(path), JournalPath(operation.OperationId), StringComparison.OrdinalIgnoreCase)
            || operation.State is not ("prepared" or "committed" or "rolledBack")
            || operation.Files.Length == 0)
            throw new InvalidDataException("Invalid writing recovery record.");
        foreach (var file in operation.Files) _ = Resolve(file.Path);
        return operation;
    }

    private Task SaveAsync(WritingOperation operation)
        => _files.WriteTextAsync(JournalPath(operation.OperationId), JsonSerializer.Serialize(operation));

    public static string OperationId(string transactionId)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(transactionId)));

    private string JournalPath(string id)
    {
        if (id.Length != 64 || id.Any(character => !char.IsAsciiHexDigit(character)))
            throw new InvalidDataException("Invalid writing operation identifier.");
        return Path.Combine(_directory, id + ".json");
    }

    private string RelativePath(string path)
    {
        var relative = Path.GetRelativePath(_root, Path.GetFullPath(path));
        _ = Resolve(relative);
        return relative;
    }

    private string Resolve(string relative)
    {
        if (Path.IsPathRooted(relative)) throw new InvalidDataException("Writing recovery paths must be relative.");
        var path = SceneDocumentReader.ResolveProjectPath(_root, relative);
        if (path.StartsWith(_directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("A writing operation cannot modify its recovery records.");
        return path;
    }

    private async Task<string?> ReadOptionalAsync(string path)
        => await _files.ExistsAsync(path) ? await _files.ReadTextAsync(path) : null;

    private Task WriteOptionalAsync(string path, string? content)
        => content is null ? _files.DeleteFileAsync(path) : _files.WriteTextAsync(path, content);
}

public sealed record WritingFileMutation(string Path, string? Before, string? After);
public sealed record WritingOperation(string OperationId, string TransactionId, string Fingerprint, string State, WritingFileMutation[] Files)
{
    public WritingSceneHash[] Hashes { get; init; } = [];
}
