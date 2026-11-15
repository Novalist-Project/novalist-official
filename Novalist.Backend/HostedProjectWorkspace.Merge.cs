#if NOVALIST_COLLABORATION
using System.Text.Json;
using Novalist.Sync.Client;

namespace Novalist.Backend;

internal sealed partial class HostedProjectWorkspace
{
    // What this device last synchronized: the shared files and the Yjs state of each shared document.
    private sealed record MergeBase(int Version, Dictionary<Guid, byte[]> Documents);
    // Files whose conflicts were not decided yet, kept so the next reconnect asks again instead of losing this device's side.
    private sealed record PendingFile(string Path, byte[]? Base, byte[]? Local, Dictionary<Guid, byte[]> Documents);
    private sealed record PendingMerge(int Version, IReadOnlyList<PendingFile> Files);
    private sealed record OpenMerge(IReadOnlyList<SharedMergeInput> Inputs, IReadOnlyDictionary<Guid, byte[]> States,
        IReadOnlyList<SharedMergeConflictDto> Conflicts);

    internal IReadOnlyList<SharedMergeConflictDto> Conflicts => current?.Merge?.Conflicts ?? [];

    // Kept apart from the connection records, which are found by listing their folder.
    private string MergeFile(string root, string suffix) =>
        Path.Combine(storage, "merge", Path.GetFileNameWithoutExtension(RegistryPath(root)) + suffix);

    /// <summary>Saves the shared project as it is now as the base the next reconnect merges local writing from.</summary>
    internal async Task SaveMergeBaseAsync(CancellationToken ct)
    {
        if (workspace.Projects.ProjectRoot is not { } root) return;
        var states = await workspace.CaptureSharedDocumentStatesAsync(ct);
        var archive = MergeFile(root, ".base.zip");
        Directory.CreateDirectory(Path.GetDirectoryName(archive) ?? throw new IOException("The collaboration storage folder is missing."));
        var staging = archive + ".tmp";
        await using (var output = new FileStream(staging, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            await ProjectCheckpoint.CreateAsync(root, output, () => ProjectContentSelection.Read(root), ct);
            await output.FlushAsync(ct);
            output.Flush(true);
        }
        File.Move(staging, archive, overwrite: true);
        await workspace.FileService.WriteTextAsync(MergeFile(root, ".base.json"), JsonSerializer.Serialize(new MergeBase(1, states)));
    }

    private async Task<(Dictionary<string, byte[]> Files, Dictionary<Guid, byte[]> Documents, bool Present)> ReadMergeBaseAsync(string root, CancellationToken ct)
    {
        var archive = MergeFile(root, ".base.zip");
        var documents = MergeFile(root, ".base.json");
        if (!File.Exists(archive) || !File.Exists(documents)) return ([], [], false);
        var saved = JsonSerializer.Deserialize<MergeBase>(await File.ReadAllTextAsync(documents, ct));
        if (saved is not { Version: 1, Documents: not null }) throw new InvalidDataException("The saved collaboration base is invalid.");
        return (await ReadArchiveAsync(archive, ct), saved.Documents, true);
    }

    private static async Task<Dictionary<string, byte[]>> ReadArchiveAsync(string path, CancellationToken ct)
    {
        await using var input = File.OpenRead(path);
        var files = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        foreach (var (relative, content) in await ProjectCheckpoint.ReadFilesAsync(input, long.MaxValue, ct))
            files[relative] = await SharedProjectFiles.FilterContentAsync(relative, content, ct);
        return files;
    }

    /// <summary>Publishes what was written on this device while it was disconnected. Files where the server
    /// changed the same thing are held back and returned as conflicts for the writer to decide.</summary>
    private async Task MergeLocalChangesAsync(Runtime runtime, string root, string retained, CancellationToken ct)
    {
        var (baseFiles, states, present) = await ReadMergeBaseAsync(root, ct);
        var local = await ReadArchiveAsync(retained, ct);
        var pendingPath = MergeFile(root, ".pending.json");
        if (File.Exists(pendingPath))
        {
            var pending = JsonSerializer.Deserialize<PendingMerge>(await File.ReadAllTextAsync(pendingPath, ct));
            if (pending is not { Version: 1, Files: not null }) throw new InvalidDataException("The saved collaboration conflicts are invalid.");
            foreach (var file in pending.Files.Where(file => SameBytes(local.GetValueOrDefault(file.Path), baseFiles.GetValueOrDefault(file.Path))))
            {
                // Untouched since the conflict was found, so the undecided local version still stands.
                Assign(baseFiles, file.Path, file.Base);
                Assign(local, file.Path, file.Local);
                foreach (var (item, state) in file.Documents) states[item] = state;
            }
        }
        var inputs = baseFiles.Keys.Union(local.Keys, StringComparer.Ordinal).Order(StringComparer.Ordinal)
            .Select(path => new SharedMergeInput(path, baseFiles.GetValueOrDefault(path), local.GetValueOrDefault(path), present)).ToArray();
        var conflicts = await workspace.MergeSharedChangesAsync(inputs, states, null, ct);
        var held = conflicts.Select(conflict => conflict.Path).ToHashSet(StringComparer.Ordinal);
        runtime.Merge = held.Count == 0 ? null : new(inputs.Where(input => held.Contains(input.Path)).ToArray(), states, conflicts);
        await SavePendingAsync(root, runtime.Merge, ct);
        await SaveMergeBaseAsync(ct);
    }

    private async Task SavePendingAsync(string root, OpenMerge? merge, CancellationToken ct)
    {
        var path = MergeFile(root, ".pending.json");
        if (merge is null)
        {
            if (File.Exists(path)) File.Delete(path);
            return;
        }
        var files = merge.Inputs.Select(input => new PendingFile(input.Path, input.Base, input.Local,
            workspace.SharedDocumentsAt(input.Path).Where(merge.States.ContainsKey).ToDictionary(item => item, item => merge.States[item]))).ToArray();
        ct.ThrowIfCancellationRequested();
        await workspace.FileService.WriteTextAsync(path, JsonSerializer.Serialize(new PendingMerge(1, files)));
    }

    private static bool SameBytes(byte[]? left, byte[]? right) => left is null ? right is null : right is not null && left.AsSpan().SequenceEqual(right);

    private static void Assign(Dictionary<string, byte[]> files, string path, byte[]? content)
    {
        if (content is null) files.Remove(path);
        else files[path] = content;
    }

    internal async Task<HostedSessionDto> ResolveConflictsAsync(IReadOnlyList<SharedMergeChoiceDto> choices, CancellationToken ct)
    {
        var runtime = current ?? throw new InvalidOperationException("Reconnect before resolving conflicts.");
        var merge = runtime.Merge ?? throw new InvalidOperationException("There are no conflicts to resolve.");
        var root = workspace.Projects.ProjectRoot ?? throw new InvalidOperationException("The shared project is closed.");
        if (choices.Any(choice => choice.Keep is not (SharedFileMerge.KeepLocal or "server")))
            throw new ArgumentException("Each conflict keeps either the local or the server version.", nameof(choices));
        var selected = choices.GroupBy(choice => choice.Path, StringComparer.Ordinal).ToDictionary(group => group.Key,
            group => (IReadOnlyDictionary<string, string>)group.ToDictionary(choice => choice.Id, choice => choice.Keep, StringComparer.Ordinal), StringComparer.Ordinal);
        await workspace.MergeSharedChangesAsync(merge.Inputs, merge.States, selected, ct);
        runtime.Merge = null;
        await SavePendingAsync(root, null, ct);
        await SaveMergeBaseAsync(ct);
        return runtime.View();
    }
}
#endif
