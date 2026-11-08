using System.Security.Cryptography;
using System.Text.Json;

namespace Novalist.Sync.Client;

public sealed record SharedFieldBinding(Guid ItemId, string Path, string Key, bool Custom, string SourceSha256)
{
    public SharedMetadataTarget? Metadata { get; init; }
}
public sealed record SharedProjectState(IReadOnlyList<SharedDocumentState> Documents, IReadOnlyList<SharedFieldBinding> Fields)
{
    public IReadOnlyDictionary<string, byte[]>? FileBaselines { get; init; }
}

/// <summary>Reads a project file by its project-relative path.</summary>
public delegate Task<byte[]> SharedFileReader(string relative, CancellationToken ct);

public static class SharedCodexFields
{
    private const int MaxFileBytes = 64 * 1024 * 1024;

    private static readonly IReadOnlyDictionary<string, string[]> BuiltIn = new Dictionary<string, string[]>
    {
        ["character"] = ["name", "surname", "gender", "age", "birthDate", "role", "group", "eyeColor", "hairColor", "hairLength", "height", "build", "skinTone"],
        ["location"] = ["name", "type", "parent", "group"],
        ["item"] = ["name", "type", "origin", "group"],
        ["lore"] = ["name", "category", "group"]
    };
    private static readonly string[] DefaultFolders = ["Characters", "Locations", "Items", "Lore"];
    private sealed record FolderSchema(string[] Keys, bool Custom);
    private sealed record Value(SharedFieldBinding Binding, string Text);

    public static Task<IReadOnlyList<SharedFieldBinding>> CaptureAsync(string root, IReadOnlyList<string> paths, CancellationToken ct) =>
        CaptureAsync(Disk(root), paths, ct);

    public static async Task<IReadOnlyList<SharedFieldBinding>> CaptureAsync(SharedFileReader read, IReadOnlyList<string> paths, CancellationToken ct)
    {
        var basic = (await EnumerateAsync(read, paths, ct)).Select(value => value.Binding with { ItemId = Guid.NewGuid() }).ToArray();
        var metadata = await SharedMetadataFields.CaptureAsync(read, paths, basic.Select(binding => binding.Path).Distinct(StringComparer.Ordinal).ToArray(), ct);
        return [.. basic, .. metadata];
    }

    public static Task<IReadOnlyDictionary<Guid, string>> ReadAsync(string root, IReadOnlyList<SharedFieldBinding> bindings, CancellationToken ct, bool verifySource = true) =>
        ReadAsync(Disk(root), bindings, ct, verifySource);

    /// <param name="verifySource">Require each source file to still hash to the binding's
    /// <see cref="SharedFieldBinding.SourceSha256"/>. Off where the file may have legitimately
    /// changed since the bindings were captured, e.g. after a joiner opened the project.</param>
    public static async Task<IReadOnlyDictionary<Guid, string>> ReadAsync(SharedFileReader read, IReadOnlyList<SharedFieldBinding> bindings, CancellationToken ct, bool verifySource = true)
    {
        ValidateBindings(bindings);
        if (bindings.Count == 0) return new Dictionary<Guid, string>();
        var paths = bindings.Select(binding => binding.Path).Distinct(StringComparer.Ordinal).ToArray();
        var basic = await EnumerateAsync(read, paths, ct);
        var values = basic.ToDictionary(value => (value.Binding.Path, value.Binding.Key, value.Binding.Custom));
        var metadata = await SharedMetadataFields.CaptureAsync(read, paths, basic.Select(value => value.Binding.Path).Distinct(StringComparer.Ordinal).ToArray(), ct);
        var result = new Dictionary<Guid, string>();
        foreach (var binding in bindings)
        {
            if (binding.Metadata is not null)
            {
                if (!metadata.Any(candidate => candidate.Path == binding.Path && candidate.Key == binding.Key && candidate.Metadata == binding.Metadata))
                    throw new InvalidDataException("A shared metadata binding is outside its editable schema.");
                result.Add(binding.ItemId, await SharedMetadataFields.ReadAsync(read, binding, verifySource, ct));
                continue;
            }
            if (!values.TryGetValue((binding.Path, binding.Key, binding.Custom), out var value))
                throw new InvalidDataException("A shared field is not an editable Codex field.");
            if (verifySource && !string.Equals(value.Binding.SourceSha256, binding.SourceSha256, StringComparison.OrdinalIgnoreCase))
                throw new IOException("A Codex entry changed while sharing was starting. Its local changes have been kept.");
            result.Add(binding.ItemId, value.Text);
        }
        return result;
    }

    internal static void ValidateBindings(IReadOnlyList<SharedFieldBinding> bindings)
    {
        var identities = new HashSet<Guid>();
        var fields = new HashSet<(string, string, bool, SharedMetadataTarget?)>();
        foreach (var binding in bindings)
        {
            if (binding is null || binding.ItemId == Guid.Empty || !identities.Add(binding.ItemId) ||
                string.IsNullOrEmpty(binding.Key) || !fields.Add((binding.Path, binding.Key, binding.Custom, binding.Metadata)) ||
                binding.SourceSha256 is null || binding.SourceSha256.Length != 64 || !binding.SourceSha256.All(Uri.IsHexDigit))
                throw new InvalidDataException("Invalid shared Codex field binding.");
            SharedProjectPath.Validate(binding.Path);
            if (binding.Metadata is not null) SharedMetadataFields.Validate(binding);
        }
    }

    private static async Task<IReadOnlyList<Value>> EnumerateAsync(SharedFileReader read, IReadOnlyList<string> paths, CancellationToken ct)
    {
        using var project = JsonDocument.Parse(await ReadBoundedAsync(read, ".novalist/project.json", ct));
        var folders = Folders(project.RootElement);
        var result = new List<Value>();
        foreach (var path in paths)
        {
            var slash = path.LastIndexOf('/');
            if (slash < 0 || !path.EndsWith(".json", StringComparison.OrdinalIgnoreCase) || !folders.TryGetValue(path[..slash], out var schema)) continue;
            var bytes = await ReadBoundedAsync(read, path, ct);
            using var entity = JsonDocument.Parse(bytes);
            var id = Text(entity.RootElement, "id");
            if (string.IsNullOrEmpty(id) || !string.Equals(Path.GetFileNameWithoutExtension(path), id, StringComparison.Ordinal))
                throw new InvalidDataException("A shared Codex entry must have a stable file identity.");
            var hash = Convert.ToHexStringLower(SHA256.HashData(bytes));
            var custom = Property(entity.RootElement, "fields");
            if (custom is { ValueKind: not JsonValueKind.Object }) throw new InvalidDataException("Invalid custom Codex fields.");
            var keys = schema.Custom ? schema.Keys.Concat(custom?.EnumerateObject().Select(field => field.Name) ?? []).Distinct(StringComparer.Ordinal) : schema.Keys;
            result.Add(new(new(Guid.Empty, path, "name", false, hash), Text(entity.RootElement, "name")));
            foreach (var key in keys.Where(key => key != "name"))
                result.Add(new(new(Guid.Empty, path, key, schema.Custom, hash),
                    schema.Custom ? custom is { } fields ? Text(fields, key, comparison: StringComparison.Ordinal) : "" : Text(entity.RootElement, key)));
        }
        return result;
    }

    private static Dictionary<string, FolderSchema> Folders(JsonElement project)
    {
        var result = new Dictionary<string, FolderSchema>(StringComparer.OrdinalIgnoreCase);
        var scopes = Elements(project, "books").Select(book => (Root: Text(book, "folderName"), Data: book))
            .Prepend((Text(project, "worldBibleFolder", "World Bible"), project));
        foreach (var (root, scope) in scopes)
        {
            SharedProjectPath.Validate(root);
            foreach (var ((type, keys), fallback) in BuiltIn.Zip(DefaultFolders))
                Add(root + '/' + Text(scope, type + "Folder", fallback), new(keys, false));
            foreach (var definition in Elements(project, "customEntityTypes"))
                Add(root + '/' + Text(definition, "folderName"), new(Elements(definition, "defaultFields").Select(field => Text(field, "key")).ToArray(), true));
        }
        return result;

        void Add(string path, FolderSchema schema)
        {
            SharedProjectPath.Validate(path);
            if (!result.TryAdd(path, schema)) throw new InvalidDataException("Codex types must have distinct storage folders to share them.");
        }
    }

    private static JsonElement? Property(JsonElement value, string key, StringComparison comparison = StringComparison.OrdinalIgnoreCase)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Invalid Codex metadata.");
        var properties = value.EnumerateObject().Where(property => property.Name.Equals(key, comparison)).ToArray();
        if (properties.Length > 1) throw new InvalidDataException("Ambiguous Codex metadata.");
        return properties.Length == 0 ? null : properties[0].Value;
    }

    private static string Text(JsonElement value, string key, string fallback = "", StringComparison comparison = StringComparison.OrdinalIgnoreCase) =>
        Property(value, key, comparison) is not { } found || found.ValueKind == JsonValueKind.Null
        ? fallback : found.ValueKind == JsonValueKind.String ? found.GetString() ?? fallback : throw new InvalidDataException("A shared Codex field must contain text.");

    private static IEnumerable<JsonElement> Elements(JsonElement value, string key) => Property(value, key) is { } found
        ? found.ValueKind == JsonValueKind.Array ? found.EnumerateArray() : throw new InvalidDataException("Invalid Codex metadata collection.") : [];

    /// <summary>Reads straight from disk, refusing a file that grows while it is read.
    /// Callers inside the app pass a reader that goes through its per-file lock instead.</summary>
    public static SharedFileReader Disk(string root) => async (relative, ct) =>
    {
        await using var stream = File.OpenRead(SharedProjectPath.Resolve(root, relative));
        if (stream.Length > MaxFileBytes) throw new InvalidDataException("Codex metadata is too large to share.");
        var bytes = new byte[checked((int)stream.Length)];
        await stream.ReadExactlyAsync(bytes, ct);
        if (await stream.ReadAsync(new byte[1], ct) != 0) throw new IOException("Codex metadata changed while it was being read.");
        return bytes;
    };

    internal static async Task<byte[]> ReadBoundedAsync(SharedFileReader read, string relative, CancellationToken ct)
    {
        var bytes = await read(relative, ct);
        return bytes.Length > MaxFileBytes ? throw new InvalidDataException("Codex metadata is too large to share.") : bytes;
    }
}
