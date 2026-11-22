#if NOVALIST_COLLABORATION
using System.Text.Json.Nodes;
using System.Text;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Novalist.Sync.Client;

namespace Novalist.Backend;

public sealed partial class Workspace
{
    private async Task ValidateNewWritingBindingsAsync(SharedStructureReceipt original, CancellationToken ct)
    {
        var scenes = RequireSharedScenes(sharedSession);
        foreach (var document in original.AfterBindings.Documents.Where(document => !original.BeforeBindings.Documents.Any(before => before.ItemId == document.ItemId)))
        {
            var item = document.TextField is null ? sharedItems[document.Path]
                : ActiveSharedProse.Single(binding => binding.Path == document.Path && binding.TextField == document.TextField).ItemId;
            var current = await scenes.ReadAsync(item, ct);
            var content = original.Changes.Single(change => change.Path == document.Path).After ?? throw new InvalidDataException("Missing created content.");
            var expected = document.TextField is { } field
                ? SharedProseFields.Target(JsonNode.Parse(content) as JsonObject ?? throw new InvalidDataException("Invalid created metadata."), field)?[field.Key]?.GetValue<string>() ?? ""
                : FileFrontMatter.Strip(Encoding.UTF8.GetString(content));
            if ((document.TextField is null ? current.Html : current.Text) != expected) throw new WritingConflictException("A collaborator changed a document created by this operation.");
        }
        foreach (var field in original.AfterBindings.Fields.Where(field => !original.BeforeBindings.Fields.Any(before => before.ItemId == field.ItemId)))
        {
            var active = ActiveFieldBindings.Single(binding => binding.Path == field.Path && binding.Key == field.Key && binding.Metadata == field.Metadata);
            var content = original.Changes.Single(change => change.Path == field.Path).After ?? throw new InvalidDataException("Missing original metadata.");
            var entity = JsonNode.Parse(content) as JsonObject ?? throw new InvalidDataException("Invalid original metadata.");
            var expected = SharedMetadataFields.Read(entity, field);
            var current = await (sharedFields ?? throw new InvalidOperationException("The shared fields are closed.")).ReadAsync(active.ItemId, ct);
            if (!JsonNode.DeepEquals(expected, JsonNode.Parse(current))) throw new WritingConflictException("A collaborator changed metadata created by this operation.");
        }
    }
}
#endif
