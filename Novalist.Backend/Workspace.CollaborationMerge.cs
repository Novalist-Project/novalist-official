#if NOVALIST_COLLABORATION
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Novalist.Core.Models;
using Novalist.Sync.Client;

namespace Novalist.Backend;

/// <summary>One place where this device and the server changed the same thing while it was disconnected.</summary>
public sealed record SharedMergeConflictDto(string Path, string Id, string Kind, string Label, string? Local, string? Server);
public sealed record SharedMergeChoiceDto(string Path, string Id, string Keep);

/// <summary>A shared file as this device last synchronized it and as it is on this device now.</summary>
internal sealed record SharedMergeInput(string Path, byte[]? Base, byte[]? Local, bool HasBase);

public sealed partial class Workspace
{
    // An empty Yjs document: merging from it treats the whole text as changed on both sides.
    private static readonly byte[] EmptySharedDocument = [0, 0];

    private sealed record SharedFieldMerge(Guid Item, string Base, string Local, bool KeepLocal);
    private sealed record SharedProseMerge(Guid Item, byte[]? Base, string Local);
    private sealed record SharedMergePlan(string Path, IReadOnlyList<SharedMergeConflictDto> Conflicts,
        IReadOnlyDictionary<string, string>? Choices, bool WritesFile = false, byte[]? Content = null,
        IReadOnlyList<SharedFieldMerge>? Fields = null, IReadOnlyList<SharedProseMerge>? Prose = null);

    internal async Task<Dictionary<Guid, byte[]>> CaptureSharedDocumentStatesAsync(CancellationToken ct)
    {
        var result = new Dictionary<Guid, byte[]>();
        if (sharedScenes is not { } scenes) return result;
        foreach (var item in sharedSceneFiles.Keys.Concat(ActiveSharedProse.Select(binding => binding.ItemId)))
            result[item] = (await scenes.ReadAsync(item, ct)).State;
        return result;
    }

    internal IEnumerable<Guid> SharedDocumentsAt(string path) =>
        sharedItems.Where(item => item.Key == path).Select(item => item.Value)
            .Concat(ActiveSharedProse.Where(binding => binding.Path == path).Select(binding => binding.ItemId));

    // A failed save must not end the session; the next reconnect then merges from the previous base.
    private async Task SaveSharedMergeBaseAsync()
    {
        try { await (HostedProjects ?? throw new InvalidOperationException("Persistent collaboration is unavailable.")).SaveMergeBaseAsync(CancellationToken.None); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            Extensions.Log.Warn($"Persistent merge base was not saved type={error.GetType().Name}.");
        }
    }

    internal Task<Dictionary<string, byte[]>> ReadSharedProjectFilesAsync(CancellationToken ct) =>
        ReadSharedFilesAsync(sharedRoot ?? throw new InvalidOperationException("The shared project is closed."), ct);

    /// <summary>Publishes what changed on this device since <see cref="SharedMergeInput.Base"/>. Without
    /// <paramref name="choices"/>, a file with any conflict is held back and its conflicts are returned;
    /// with them, every file is published and an unchosen conflict keeps the server's version.</summary>
    internal async Task<IReadOnlyList<SharedMergeConflictDto>> MergeSharedChangesAsync(IReadOnlyList<SharedMergeInput> inputs,
        IReadOnlyDictionary<Guid, byte[]> baseStates, IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>>? choices, CancellationToken ct)
    {
        var server = await ReadSharedProjectFilesAsync(ct);
        var held = new List<SharedMergeConflictDto>();
        var plans = new List<SharedMergePlan>();
        foreach (var input in inputs)
        {
            var plan = await PlanSharedMergeAsync(input, server.GetValueOrDefault(input.Path), baseStates,
                choices?.GetValueOrDefault(input.Path), liveBase: false, ct);
            if (choices is null && plan.Conflicts.Count > 0) held.AddRange(plan.Conflicts);
            else plans.Add(plan);
        }
        await ApplySharedMergeAsync(plans, ct);
        return held;
    }

    private async Task<SharedMergePlan> PlanSharedMergeAsync(SharedMergeInput input, byte[]? server, IReadOnlyDictionary<Guid, byte[]> baseStates,
        IReadOnlyDictionary<string, string>? choices, bool liveBase, CancellationToken ct)
    {
        var (path, before, local) = (input.Path, input.Base, input.Local);
        var empty = new SharedMergePlan(path, [], choices);
        var keepLocal = choices?.GetValueOrDefault(SharedFileMerge.WholeFile) == SharedFileMerge.KeepLocal;
        if (!input.HasBase)
        {
            if (SameSharedFileContent(path, local, server)) return empty;
            return keepLocal ? await TakeLocalFileAsync(input, server, baseStates, ct) : WholeFileConflict(path, local, server, choices);
        }
        if (SameSharedFileContent(path, before, local)) return empty;
        if (before is not null && local is null)
        {
            if (server is null) return empty;
            if (SameSharedFileContent(path, before, server)) return empty with { WritesFile = true };
            return keepLocal ? empty with { WritesFile = true } : WholeFileConflict(path, local, server, choices);
        }
        if (server is null)
            return before is null || keepLocal ? empty with { WritesFile = true, Content = local } : WholeFileConflict(path, local, server, choices);
        if (before is null)
        {
            if (SameSharedFileContent(path, local, server)) return empty;
            return keepLocal ? await TakeLocalFileAsync(input, server, baseStates, ct) : WholeFileConflict(path, local, server, choices);
        }
        return await PlanSharedContentMergeAsync(path, before, local!, server, baseStates, choices, liveBase, ct);
    }

    // Taking this device's whole file means merging it against the server's version as if nothing changed there.
    private Task<SharedMergePlan> TakeLocalFileAsync(SharedMergeInput input, byte[]? server, IReadOnlyDictionary<Guid, byte[]> baseStates, CancellationToken ct) =>
        server is null
            ? Task.FromResult(new SharedMergePlan(input.Path, [], null, WritesFile: true, Content: input.Local))
            : PlanSharedMergeAsync(input with { Base = server, HasBase = true }, server, baseStates, null, liveBase: true, ct);

    private SharedMergePlan WholeFileConflict(string path, byte[]? local, byte[]? server, IReadOnlyDictionary<string, string>? choices) =>
        new(path, [new(path, SharedFileMerge.WholeFile, "file", SharedMergeLabel(path, local ?? server),
            SharedFileMerge.Preview(local), SharedFileMerge.Preview(server))], choices);

    private async Task<SharedMergePlan> PlanSharedContentMergeAsync(string path, byte[] before, byte[] local, byte[] server,
        IReadOnlyDictionary<Guid, byte[]> baseStates, IReadOnlyDictionary<string, string>? choices, bool liveBase, CancellationToken ct)
    {
        var label = SharedMergeLabel(path, local);
        var conflicts = new List<SharedMergeConflictDto>();
        var prose = new List<SharedProseMerge>();
        var fields = new List<SharedFieldMerge>();
        async Task AddProseAsync(Guid item, string text)
        {
            var state = liveBase ? (await RequireSharedScenes(sharedSession).ReadAsync(item, ct)).State : baseStates.GetValueOrDefault(item);
            conflicts.AddRange(await MergeSharedDocumentAsync(path, label, new(item, state, text), choices, apply: false, ct));
            prose.Add(new(item, state, text));
        }
        if (sharedItems.TryGetValue(path, out var scene))
        {
            var text = SceneBody(local);
            if (text != SceneBody(before) || liveBase) await AddProseAsync(scene, text);
        }
        else if (path.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
        {
            var original = JsonNode.Parse(before) as JsonObject;
            var mine = JsonNode.Parse(local) as JsonObject;
            foreach (var binding in ActiveSharedProse.Where(binding => binding.Path == path).ToArray())
            {
                var field = RequireTextField(binding);
                var text = ProseText(mine, field);
                if (text is not null && (text != ProseText(original, field) || liveBase)) await AddProseAsync(binding.ItemId, text);
            }
            foreach (var binding in ActiveFieldBindings.Where(binding => binding.Path == path).ToArray())
                fields.AddRange(await PlanSharedFieldAsync(path, label, binding, before, local, choices, conflicts, ct));
        }
        var structure = SharedFileMerge.Resolve(new(path, MaskSeparatelySharedContent(path, before, server),
            MaskSeparatelySharedContent(path, local, server)), server, choices);
        conflicts.AddRange(structure.Conflicts.Select(conflict => conflict.Id == SharedFileMerge.WholeFile
            ? new SharedMergeConflictDto(path, conflict.Id, "file", label, SharedFileMerge.Preview(local), SharedFileMerge.Preview(server))
            : new SharedMergeConflictDto(path, conflict.Id, "structure", label, conflict.Local, conflict.Server)));
        return new(path, conflicts, choices, !SameSharedFileContent(path, structure.Content, server), structure.Content, fields, prose);
    }

    private async Task<IReadOnlyList<SharedFieldMerge>> PlanSharedFieldAsync(string path, string label, SharedFieldBinding binding, byte[] before, byte[] local,
        IReadOnlyDictionary<string, string>? choices, List<SharedMergeConflictDto> conflicts, CancellationToken ct)
    {
        var original = await ReadFieldValueAsync(path, before, binding, ct);
        var mine = await ReadFieldValueAsync(path, local, binding, ct);
        if (original is null || mine is null || original == mine) return [];
        var current = await (sharedFields ?? throw new InvalidOperationException("The shared project is closed.")).ReadAsync(binding.ItemId, ct);
        if (current == mine) return [];
        if (current == original) return [new(binding.ItemId, original, mine, true)];
        var id = "field:" + SharedMetadataFields.BindingKey(binding);
        conflicts.Add(new(path, id, "field", label + " · " + binding.Key, mine, current));
        return choices?.GetValueOrDefault(id) == SharedFileMerge.KeepLocal ? [new(binding.ItemId, original, mine, true)] : [];
    }

    // Null when the field is not editable in that version of the file, so there is nothing to merge.
    private async Task<string?> ReadFieldValueAsync(string path, byte[] content, SharedFieldBinding binding, CancellationToken ct)
    {
        var disk = LockedSharedFiles(sharedRoot ?? throw new InvalidOperationException("The shared project is closed."));
        try
        {
            // Only the entry itself comes from the merged version; the project file that locates entries stays as shared.
            var values = await SharedCodexFields.ReadAsync((relative, token) => relative == path ? Task.FromResult(content) : disk(relative, token),
                [binding], ct, verifySource: false);
            return values.GetValueOrDefault(binding.ItemId);
        }
        catch (Exception error) when (error is InvalidDataException or JsonException) { return null; }
    }

    private async Task<IReadOnlyList<SharedMergeConflictDto>> MergeSharedDocumentAsync(string path, string label, SharedProseMerge merge,
        IReadOnlyDictionary<string, string>? choices, bool apply, CancellationToken ct)
    {
        var prefix = merge.Item.ToString("N") + ':';
        var selected = choices?.Where(choice => choice.Key.StartsWith(prefix, StringComparison.Ordinal))
            .ToDictionary(choice => choice.Key[prefix.Length..], choice => choice.Value, StringComparer.Ordinal);
        var result = await RequireSharedScenes(sharedSession).MergeAsync(merge.Item, merge.Base ?? EmptySharedDocument, merge.Local, selected, apply, ct);
        return result.Conflicts.Select(conflict => new SharedMergeConflictDto(path, prefix + conflict.Id, "prose", label, conflict.Local, conflict.Server)).ToArray();
    }

    private async Task ApplySharedMergeAsync(IReadOnlyList<SharedMergePlan> plans, CancellationToken ct)
    {
        var root = sharedRoot ?? throw new InvalidOperationException("The shared project is closed.");
        var structural = plans.Where(plan => plan.WritesFile).ToArray();
        foreach (var plan in structural) await WriteMergedFileAsync(root, plan);
        if (structural.Length > 0)
        {
            await FlushSharedProjectFilesAsync();
            await ReloadSharedWorkspaceAsync();
            if (Coordinator?.Notify is { } notify) await notify("collaboration/projectUpdated", new { sessionId = sharedSession, state = BuildState() });
        }
        foreach (var plan in plans)
        {
            foreach (var field in plan.Fields ?? []) await WriteMergedFieldAsync(root, plan.Path, field, ct);
            foreach (var prose in plan.Prose ?? []) await MergeSharedDocumentAsync(plan.Path, "", prose, plan.Choices, apply: true, ct);
        }
    }

    private async Task WriteMergedFileAsync(string root, SharedMergePlan plan)
    {
        var path = SharedProjectPath.Resolve(root, plan.Path);
        var current = await FileService.ExistsAsync(path) ? await FileService.ReadBytesAsync(path) : null;
        if (plan.Content is null)
        {
            if (current is not null) await FileService.DeleteFileAsync(path);
            return;
        }
        var shared = current is null ? null : await SharedProjectFiles.FilterContentAsync(plan.Path, current, CancellationToken.None);
        // The merge saw the filtered file; merging into what is on disk keeps personal settings and later shared edits.
        var merged = current is null ? new(plan.Content, false) : SharedFileMerge.Apply(new(plan.Path, shared, plan.Content), current);
        if (merged.Conflict) await WriteSharedFileRecoveryAsync(root, "merge", plan.Path, plan.Content);
        if (merged.Content is null) await FileService.DeleteFileAsync(path);
        else if (!SameFileBytes(merged.Content, current)) await FileService.WriteBytesAsync(path, merged.Content);
    }

    private async Task WriteMergedFieldAsync(string root, string path, SharedFieldMerge merge, CancellationToken ct)
    {
        var focus = Guid.NewGuid();
        var focused = await AcquireSharedFieldAsync(sharedSession, merge.Item, focus, ct);
        var field = RequireSharedField(sharedSession, merge.Item, focus);
        try
        {
            var settled = focused.Lease.Acquired && focused.Value == merge.Local;
            var writable = focused.Lease.Acquired && (focused.Value == merge.Base || merge.KeepLocal);
            if (writable && !settled) await WriteSharedFieldAsync(sharedSession, merge.Item, focus, merge.Local, ct);
            // Someone else holds the field or changed it since: their value stays and this device's is kept aside.
            else if (!settled) await WriteSharedFileRecoveryAsync(root, merge.Item.ToString("N"), path,
                JsonSerializer.SerializeToUtf8Bytes(new { fieldBindings[merge.Item].Key, Value = merge.Local }));
        }
        finally
        {
            if (focused.Lease.Acquired) await field.Session.ReleaseFieldAsync(field.Lease, CancellationToken.None);
        }
    }

    private static string SceneBody(byte[] content) => FileFrontMatter.Strip(new UTF8Encoding(false, true).GetString(content).TrimStart('\uFEFF'));

    private static string? ProseText(JsonObject? entity, SharedTextField field) =>
        entity is null ? null : SharedProseFields.Target(entity, field)?[field.Key]?.GetValue<string>() ?? "";

    private string SharedMergeLabel(string path, byte[]? content)
    {
        if (Projects.ProjectRoot is { } root && Projects.ActiveBook is { } book && Projects.ScenesManifest is { } manifest)
        {
            foreach (var chapter in book.Chapters)
                foreach (var scene in manifest.Chapters.GetValueOrDefault(chapter.Guid) ?? [])
                    if (Path.GetRelativePath(root, Projects.GetSceneFilePath(chapter, scene)).Replace('\\', '/') == path) return $"{chapter.Title} · {scene.Title}";
        }
        if (path.EndsWith(".json", StringComparison.OrdinalIgnoreCase) && SharedFileMerge.Preview(content) is { } text)
        {
            try
            {
                if (JsonNode.Parse(text) is JsonObject entity && SharedEntityName(entity) is { Length: > 0 } name) return name;
            }
            catch (Exception error) when (error is JsonException or InvalidOperationException) { }
        }
        return Path.GetFileName(path);
    }
}
#endif
