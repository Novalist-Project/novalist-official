using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Novalist.Sync.Client;

internal sealed class SharedFieldReadBatch(Func<string, CancellationToken, Task<byte[]>> read)
{
    private readonly Dictionary<string, byte[]> files = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> hashes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, JsonObject> roots = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Dictionary<string, JsonObject>> scenes = new(StringComparer.Ordinal);

    internal async Task<byte[]> ReadAsync(string path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (files.TryGetValue(path, out var bytes)) return bytes;
        bytes = await read(path, ct);
        files.Add(path, bytes);
        hashes.Add(path, Hash(bytes));
        return bytes;
    }

    internal async Task<string> ReadMetadataAsync(SharedFieldBinding binding, bool verifySource, CancellationToken ct)
    {
        var bytes = await ReadAsync(binding.Path, ct);
        if (verifySource && !hashes[binding.Path].Equals(binding.SourceSha256, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Shared metadata changed during capture. Its local edits have been kept.");
        if (!roots.TryGetValue(binding.Path, out var root))
        {
            root = JsonNode.Parse(bytes) as JsonObject ?? throw new InvalidDataException("Invalid shared metadata.");
            roots.Add(binding.Path, root);
        }
        var value = binding.Metadata is { Kind: "scene", Identity: { } sceneId }
            ? SharedMetadataFields.ReadTarget(Scene(binding.Path, root, sceneId), binding)
            : SharedMetadataFields.Read(root, binding);
        return value?.ToJsonString() ?? "null";
    }

    private JsonObject? Scene(string path, JsonObject root, string identity)
    {
        if (!scenes.TryGetValue(path, out var index))
        {
            index = new(StringComparer.Ordinal);
            foreach (var chapter in root["chapters"] as JsonObject ?? [])
                foreach (var scene in (chapter.Value as JsonArray)?.OfType<JsonObject>() ?? [])
                {
                    var id = scene["id"]?.GetValue<string>() ?? throw new InvalidDataException("Shared metadata needs a stable identity.");
                    if (!index.TryAdd(id, scene)) throw new InvalidDataException("Shared scenes need distinct identities within a draft.");
                }
            scenes.Add(path, index);
        }
        return index.GetValueOrDefault(identity);
    }

    internal async Task VerifyAsync(CancellationToken ct)
    {
        foreach (var (path, hash) in hashes)
            if (Hash(await read(path, ct)) != hash)
                throw new IOException("Shared metadata changed during capture. Its local edits have been kept.");
    }

    private static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));
}
