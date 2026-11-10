#if NOVALIST_COLLABORATION
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Novalist.Sync.Client;

namespace Novalist.Backend;

public sealed partial class Workspace
{
    private async Task<SharedProjectState> CaptureWritingBindingsAsync(IReadOnlyList<SharedFileChange> changes,
        SharedSplitPreparation? split, CancellationToken ct)
    {
        var root = sharedRoot ?? throw new InvalidOperationException("The shared project is closed.");
        var after = changes.Where(change => change.After is not null).ToDictionary(change => change.Path, change => change.After ?? throw new InvalidDataException("Missing staged content."));
        Task<byte[]> Read(string path, CancellationToken token) => after.TryGetValue(path, out var bytes)
            ? Task.FromResult(bytes) : FileService.ReadBytesAsync(SharedProjectPath.Resolve(root, path));
        var fields = (await SharedCodexFields.CaptureAsync(root, after.Keys.ToArray(), ct, Read)).Where(candidate =>
            !ActiveFieldBindings.Any(existing => existing.Path == candidate.Path && existing.Key == candidate.Key && existing.Custom == candidate.Custom && existing.Metadata == candidate.Metadata)).ToArray();
        var factory = CreateSharedDocuments ?? throw new InvalidOperationException("Desktop collaboration is unavailable.");
        await using var host = factory(Guid.NewGuid());
        await host.OpenAsync(ct);
        var documents = new List<SharedDocumentState>();
        foreach (var change in changes.Where(change => change.After is not null))
        {
            var content = after[change.Path];
            var hash = Convert.ToHexStringLower(SHA256.HashData(content));
            if (change.Path.EndsWith(".novalist", StringComparison.OrdinalIgnoreCase) && change.Before is null)
            {
                var text = Encoding.UTF8.GetString(content);
                if (!FileFrontMatter.TryParse(text, out var marker)) throw new InvalidDataException("A shared scene needs its identity.");
                var moved = sharedSceneFiles.FirstOrDefault(file => file.Value.SceneId == marker.Id && changes.Any(candidate => candidate.Path == file.Value.Relative && candidate.After is null));
                var id = moved.Key != Guid.Empty ? moved.Key : split?.CreatedItemId ?? Guid.NewGuid();
                byte[] state;
                if (moved.Key != Guid.Empty) state = (await RequireSharedScenes(sharedSession).ReadAsync(id, ct)).State;
                else if (split is not null) state = split.CreatedState;
                else { await host.SeedAsync(id, FileFrontMatter.Strip(text), ct); state = (await host.CaptureAsync(id, ct)).State; }
                documents.Add(new(id, change.Path, state) { SourceSha256 = hash });
            }
            if (!change.Path.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) continue;
            var entity = JsonNode.Parse(content) as JsonObject ?? throw new InvalidDataException("Invalid shared writing metadata.");
            foreach (var field in SharedProseFields.Enumerate(entity))
            {
                if (ActiveSharedProse.Any(binding => binding.Path == change.Path && binding.TextField == field)) continue;
                var id = Guid.NewGuid();
                await host.SeedTextAsync(id, SharedProseFields.Target(entity, field)?[field.Key]?.GetValue<string>() ?? "", ct);
                documents.Add(new(id, change.Path, (await host.CaptureAsync(id, ct)).State) { TextField = field, SourceSha256 = hash });
            }
        }
        return new(documents, fields);
    }
}
#endif
