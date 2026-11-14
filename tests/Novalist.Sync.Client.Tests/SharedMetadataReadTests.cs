using System.Text.Json;
using Xunit;

namespace Novalist.Sync.Client.Tests;

public sealed class SharedMetadataReadTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "novalist-metadata-read", Guid.NewGuid().ToString("N"));
    private readonly CancellationToken ct = TestContext.Current.CancellationToken;
    private const string First = "Book/Drafts/first/scenes.json";
    private const string Second = "Book/Drafts/second/scenes.json";

    private async Task<IReadOnlyList<SharedFieldBinding>> CreateAsync()
    {
        Directory.CreateDirectory(Path.Combine(root, ".novalist"));
        await File.WriteAllTextAsync(Path.Combine(root, ".novalist/project.json"),
            """{"books":[{"folderName":"Book","drafts":[{"folderName":"first"},{"folderName":"second"}]}]}""", ct);
        foreach (var path in new[] { First, Second })
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(root, path)) ?? throw new InvalidOperationException());
            var scenes = Enumerable.Range(0, 50).Select(index => new { id = "scene-" + index, title = path + index,
                analysisOverrides = new { tags = new[] { "tag" + index } }, properties = new { stage = "outline" } });
            await File.WriteAllTextAsync(Path.Combine(root, path), JsonSerializer.Serialize(new { chapters = new { chapter = scenes } }), ct);
        }
        return await SharedCodexFields.CaptureAsync(root, [First, Second], ct);
    }

    [Fact]
    public async Task ReadsAndRevalidatesEachManifestOnceRegardlessOfFieldCount()
    {
        var fields = await CreateAsync();
        var reads = new Dictionary<string, int>();
        var values = await SharedCodexFields.ReadAsync(root, fields, ct, true, async (path, token) =>
        {
            reads[path] = reads.GetValueOrDefault(path) + 1;
            return await File.ReadAllBytesAsync(Path.Combine(root, path), token);
        });
        Assert.Equal(fields.Count, values.Count);
        foreach (var path in new[] { First, Second })
        {
            Assert.Equal(2, reads[path]);
            Assert.Equal(JsonSerializer.Serialize(path + "0"), values[fields.Single(field => field.Path == path && field.Key == "title" && field.Metadata?.Identity == "scene-0").ItemId]);
            Assert.Equal("null", values[fields.Single(field => field.Path == path && field.Key == "date" && field.Metadata?.Identity == "scene-0").ItemId]);
            Assert.Equal("[\"tag0\"]", values[fields.Single(field => field.Path == path && field.Key == "analysisOverrides.tags" && field.Metadata?.Identity == "scene-0").ItemId]);
        }
        Assert.Equal(2, reads[".novalist/project.json"]);
    }

    [Fact]
    public async Task RejectsFilesChangedDuringTheBatchEvenWhenOldSourceVerificationIsDisabled()
    {
        var fields = await CreateAsync();
        var reads = new Dictionary<string, int>();
        await Assert.ThrowsAsync<IOException>(() => SharedCodexFields.ReadAsync(root, fields, ct, false, async (path, token) =>
        {
            reads[path] = reads.GetValueOrDefault(path) + 1;
            if (path == First && reads[path] == 2) await File.AppendAllTextAsync(Path.Combine(root, path), " ", token);
            return await File.ReadAllBytesAsync(Path.Combine(root, path), token);
        }));
    }

    [Fact]
    public async Task SourceHashesRemainBindingSpecificAndNewReadsSeeNewFiles()
    {
        var fields = await CreateAsync();
        var invalid = fields.ToArray();
        invalid[^1] = invalid[^1] with { SourceSha256 = new string('0', 64) };
        await Assert.ThrowsAsync<IOException>(() => SharedCodexFields.ReadAsync(root, invalid, ct));
        var path = Path.Combine(root, First);
        await File.WriteAllTextAsync(path, (await File.ReadAllTextAsync(path, ct)).Replace(First + "0", "Revised"), ct);
        await Assert.ThrowsAsync<IOException>(() => SharedCodexFields.ReadAsync(root, fields, ct));
        var updated = await SharedCodexFields.ReadAsync(root, fields, ct, verifySource: false);
        Assert.Equal("\"Revised\"", updated[fields.Single(field => field.Path == First && field.Key == "title" && field.Metadata?.Identity == "scene-0").ItemId]);
    }

    [Fact]
    public async Task InvalidSchemaAndCancellationRemainRejected()
    {
        var fields = await CreateAsync();
        await Assert.ThrowsAsync<InvalidDataException>(() => SharedCodexFields.ReadAsync(root,
            [fields[0] with { Metadata = new("scene", "missing") }], ct));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => SharedCodexFields.ReadAsync(root, fields, new CancellationToken(true)));
    }

    public void Dispose() { TestFiles.DeleteTree(root); }
}
