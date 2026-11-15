using System.Text;
using System.Text.Json;
using Novalist.Sync.Client;
using StreamJsonRpc;

namespace Novalist.Backend.Tests.TestHelpers;

internal sealed class CollaborationDocumentPeer
{
    private readonly Dictionary<Guid, byte[]> states = [];
    private readonly Dictionary<Guid, byte[]> removed = [];
    internal Func<CancellationToken, Task>? BeforeSeed { get; set; }
    internal Action? BeforeCapture { get; set; }
    internal bool RejectNextLoad { get; set; }
    internal Guid? RejectLoadItem { get; set; }
    internal bool RemoveSeededScenes { get; set; }
    internal Guid? RejectRenameItem { get; set; }
    internal Func<Guid, Task>? AfterRename { get; set; }

    internal List<(Guid Item, string Local, Dictionary<string, string>? Choices)> Merges { get; } = [];

    // Whole-text stand-in for the Yjs merge: either side alone wins, both sides changing differently is one conflict.
    private SceneMergeResult Merge(Guid item, byte[] baseState, string local, Dictionary<string, string>? choices)
    {
        Merges.Add((item, local, choices));
        var current = Encoding.UTF8.GetString(states[item]);
        var prefix = current.StartsWith("text:", StringComparison.Ordinal) ? "text:" : current.StartsWith("html:", StringComparison.Ordinal) ? "html:" : "";
        var server = current[prefix.Length..];
        var original = baseState is [0, 0] ? "" : Strip(Encoding.UTF8.GetString(baseState));
        byte[] Update() => Encoding.UTF8.GetBytes(prefix + local);
        if (local == original || local == server) return new(true, [], null);
        if (server == original) return new(true, [], Update());
        SceneMergeConflict[] conflicts = [new("0", local, server)];
        return new(true, conflicts, choices?.GetValueOrDefault("0") == "local" ? Update() : null);
    }

    private static string Strip(string state) =>
        state.StartsWith("text:", StringComparison.Ordinal) || state.StartsWith("html:", StringComparison.Ordinal) ? state[5..] : state;

    [JsonRpcMethod("collaboration/documents")]
    public async Task<object?> Documents(string action, JsonElement command = default, Guid? id = null,
        string? entityId = null, string? oldName = null, string? newName = null, byte[]? @base = null, string? local = null,
        Dictionary<string, string>? choices = null, CancellationToken cancellationToken = default)
    {
        if (action == "merge") return Merge(id ?? throw new ArgumentException("Missing merge identity."),
            @base ?? throw new ArgumentException("Missing merge base."), local ?? throw new ArgumentException("Missing local prose."), choices);
        if (action == "rename")
        {
            if (id is null || string.IsNullOrEmpty(entityId) || string.IsNullOrEmpty(oldName) || newName is null)
                throw new ArgumentException("Missing rename parameters.");
            if (RejectRenameItem == id) { RejectRenameItem = null; throw new IOException("Rename interrupted."); }
            var previous = Encoding.UTF8.GetString(states[id.Value]);
            var next = previous.Replace(oldName, newName, StringComparison.Ordinal);
            if (next == previous) return null;
            if (AfterRename is { } after) await after(id.Value);
            return Convert.ToBase64String(Encoding.UTF8.GetBytes(next));
        }
        if (action == "execute")
        {
            var item = command.GetProperty("id").GetGuid();
            var kind = command.GetProperty("kind").GetString();
            if (kind == "seed" && BeforeSeed is { } beforeSeed) await beforeSeed(cancellationToken);
            if (kind == "load" && (RejectNextLoad || RejectLoadItem == item))
            {
                RejectNextLoad = false;
                RejectLoadItem = null;
                throw new InvalidOperationException("Document host unavailable.");
            }
            if (kind == "seed") states[item] = Encoding.UTF8.GetBytes("html:" + command.GetProperty("html").GetString());
            if (kind == "seed" && RemoveSeededScenes) removed[item] = states[item];
            if (kind == "seedText") states[item] = Encoding.UTF8.GetBytes("text:" + command.GetProperty("text").GetString());
            if (kind == "load") { states[item] = command.GetProperty("state").GetBytesFromBase64(); removed.Remove(item); }
            if (kind == "remove") removed[item] = command.GetProperty("state").GetBytesFromBase64();
            if (kind == "receive")
            {
                states[item] = command.GetProperty("state").GetBytesFromBase64();
                return new SceneApplyResult(true, []);
            }
        }
        if (action != "capture" || id is null) return null;
        BeforeCapture?.Invoke();
        var state = states[id.Value];
        var value = Encoding.UTF8.GetString(state);
        if (value.StartsWith("html:", StringComparison.Ordinal)) value = value[5..];
        if (removed.TryGetValue(id.Value, out var deletedAt))
        {
            var changed = !state.AsSpan().SequenceEqual(deletedAt);
            return value.StartsWith("text:", StringComparison.Ordinal)
                ? new SharedSceneSnapshot(state, [deletedAt], null, null) { RecoveredText = changed ? value[5..] : null }
                : new SharedSceneSnapshot(state, [deletedAt], null, changed ? value : null);
        }
        return value.StartsWith("text:", StringComparison.Ordinal)
            ? new SharedSceneSnapshot(state, [], null, null) { Text = value[5..] }
            : new SharedSceneSnapshot(state, [], value, null);
    }
}
