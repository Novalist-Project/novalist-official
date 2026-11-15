using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Novalist.Sync.Client;

public sealed record SharedFileMergeResult(byte[]? Content, bool Conflict);
public sealed record SharedFileConflict(string Id, string? Local, string? Server);
public sealed record SharedFileResolution(byte[]? Content, IReadOnlyList<SharedFileConflict> Conflicts);

public static class SharedFileMerge
{
    public const string WholeFile = "file";
    public const string KeepLocal = "local";
    private const int PreviewLimit = 64 * 1024;

    public static SharedFileMergeResult Apply(SharedFileChange change, byte[]? current)
    {
        if (Equal(change.Before, change.After) || Equal(current, change.After)) return new(current?.ToArray(), false);
        if (Equal(current, change.Before)) return new(change.After?.ToArray(), false);
        if (change.After is null) return new(null, current is not null);
        if (current is null && change.Before is not null) return new(null, true);
        if (change.Before is null || current is null) return new(current?.ToArray(), true);
        try
        {
            var result = Merge(Parse(change.Before), Parse(change.After), Parse(current), null);
            return new(JsonSerializer.SerializeToUtf8Bytes(result.Value.Node), result.Conflict);
        }
        catch (JsonException) { return new(current.ToArray(), true); }
    }

    /// <summary>Merges a local change into <paramref name="current"/> and names every place both sides changed
    /// differently. A conflict takes the local side when <paramref name="choices"/> maps its id to
    /// <see cref="KeepLocal"/>; otherwise it keeps <paramref name="current"/>.</summary>
    public static SharedFileResolution Resolve(SharedFileChange change, byte[]? current, IReadOnlyDictionary<string, string>? choices)
    {
        if (Equal(change.Before, change.After) || Equal(current, change.After)) return new(current?.ToArray(), []);
        if (Equal(current, change.Before)) return new(change.After?.ToArray(), []);
        if (change.Before is not null && change.After is not null && current is not null)
        {
            try
            {
                var conflicts = new List<SharedFileConflict>();
                var result = Merge(Parse(change.Before), Parse(change.After), Parse(current), new(choices, conflicts));
                return new(JsonSerializer.SerializeToUtf8Bytes(result.Value.Node), conflicts);
            }
            catch (JsonException) { }
        }
        var local = choices?.GetValueOrDefault(WholeFile) == KeepLocal;
        return new((local ? change.After : current)?.ToArray(), [new(WholeFile, Preview(change.After), Preview(current))]);
    }

    /// <summary>The file as readable text, or null when it is absent, binary or too large to show.</summary>
    public static string? Preview(byte[]? content)
    {
        if (content is null || content.Length > PreviewLimit || content.Contains((byte)0)) return null;
        try { return new UTF8Encoding(false, true).GetString(content); }
        catch (DecoderFallbackException) { return null; }
    }

    internal static bool Equal(byte[]? left, byte[]? right) => left is null ? right is null : right is not null && left.AsSpan().SequenceEqual(right);
    private static Value Parse(byte[] content) => new(true, JsonNode.Parse(content));
    private readonly record struct Value(bool Present, JsonNode? Node);
    private readonly record struct Result(Value Value, bool Conflict);
    private sealed record Choices(IReadOnlyDictionary<string, string>? Selected, List<SharedFileConflict> Found);

    private static Result Merge(Value before, Value after, Value current, Choices? choices, string pointer = "")
    {
        if (Same(before, after) || Same(current, after)) return new(current, false);
        if (Same(before, current)) return new(after, false);
        if (!after.Present || (!current.Present && before.Present)) return Conflict(after, current, new(false, null), choices, pointer);
        if (before.Node is JsonObject oldObject && after.Node is JsonObject newObject && current.Node is JsonObject currentObject)
            return MergeObject(oldObject, newObject, currentObject, choices, pointer);
        if (before.Node is JsonArray oldArray && after.Node is JsonArray newArray && current.Node is JsonArray currentArray &&
            Index(oldArray) is { } oldItems && Index(newArray) is { } newItems && Index(currentArray) is { } currentItems)
            return MergeArray(oldItems, newItems, currentItems, choices, pointer);
        return Conflict(after, current, current, choices, pointer);
    }

    private static Result Conflict(Value after, Value current, Value unresolved, Choices? choices, string pointer)
    {
        if (choices is null) return new(unresolved, true);
        var id = pointer.Length == 0 ? "/" : pointer;
        choices.Found.Add(new(id, Text(after), Text(current)));
        return new(choices.Selected?.GetValueOrDefault(id) == KeepLocal ? after : current, true);
    }

    private static string? Text(Value value) => value.Present ? value.Node?.ToJsonString() ?? "null" : null;

    private static Result MergeObject(JsonObject before, JsonObject after, JsonObject current, Choices? choices, string pointer)
    {
        var output = new JsonObject();
        var conflict = false;
        foreach (var key in current.Select(pair => pair.Key).Concat(after.Select(pair => pair.Key)).Concat(before.Select(pair => pair.Key)).Distinct(StringComparer.Ordinal))
        {
            var result = Merge(Read(before, key), Read(after, key), Read(current, key), choices, pointer + '/' + Escape(key));
            conflict |= result.Conflict;
            if (result.Value.Present) output[key] = result.Value.Node?.DeepClone();
        }
        return new(new(true, output), conflict);
    }

    private static Result MergeArray(Dictionary<string, JsonNode?> before, Dictionary<string, JsonNode?> after, Dictionary<string, JsonNode?> current,
        Choices? choices, string pointer)
    {
        var common = before.Keys.Where(after.ContainsKey).ToHashSet(StringComparer.Ordinal);
        var reordered = !before.Keys.Where(common.Contains).SequenceEqual(after.Keys.Where(common.Contains));
        var order = reordered ? after.Keys.Concat(current.Keys) : current.Keys.Concat(after.Keys);
        var output = new JsonArray();
        var conflict = false;
        foreach (var key in order.Concat(before.Keys).Distinct(StringComparer.Ordinal))
        {
            var result = Merge(Read(before, key), Read(after, key), Read(current, key), choices, pointer + '/' + Escape(key));
            conflict |= result.Conflict;
            if (result.Value.Present) output.Add(result.Value.Node?.DeepClone());
        }
        return new(new(true, output), conflict);
    }

    private static string Escape(string key) => key.Replace("~", "~0", StringComparison.Ordinal).Replace("/", "~1", StringComparison.Ordinal);

    private static Dictionary<string, JsonNode?>? Index(JsonArray array)
    {
        var result = new Dictionary<string, JsonNode?>(StringComparer.Ordinal);
        foreach (var item in array)
        {
            var identity = item is JsonObject obj
                ? obj.FirstOrDefault(pair => pair.Key.Equals("id", StringComparison.OrdinalIgnoreCase) || pair.Key.Equals("guid", StringComparison.OrdinalIgnoreCase)).Value
                : item;
            if (identity is not JsonValue value || !result.TryAdd(value.ToJsonString(), item)) return null;
        }
        return result;
    }

    private static bool Same(Value left, Value right) => left.Present == right.Present && JsonNode.DeepEquals(left.Node, right.Node);
    private static Value Read(IDictionary<string, JsonNode?> source, string key) => source.TryGetValue(key, out var node) ? new(true, node) : new(false, null);
}
