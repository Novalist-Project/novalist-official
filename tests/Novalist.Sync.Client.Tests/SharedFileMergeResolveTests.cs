using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace Novalist.Sync.Client.Tests;

public sealed class SharedFileMergeResolveTests
{
    private static byte[] Bytes(string text) => Encoding.UTF8.GetBytes(text);
    private static SharedFileResolution Resolve(string? before, string? after, string? current, Dictionary<string, string>? choices = null) =>
        SharedFileMerge.Resolve(new("Research/entry.json", before is null ? null : Bytes(before), after is null ? null : Bytes(after)),
            current is null ? null : Bytes(current), choices);

    [Fact]
    public void ChangesOnOneSideMergeWithoutConflicts()
    {
        Assert.Equal("{\"a\":2}", Encoding.UTF8.GetString(Resolve("{\"a\":1}", "{\"a\":2}", "{\"a\":1}").Content!));
        Assert.Equal("{\"a\":3}", Encoding.UTF8.GetString(Resolve("{\"a\":1}", "{\"a\":1}", "{\"a\":3}").Content!));
        var merged = Resolve("{\"a\":1,\"b\":1}", "{\"a\":2,\"b\":1}", "{\"a\":1,\"b\":3}");
        Assert.Empty(merged.Conflicts);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse("{\"a\":2,\"b\":3}"), JsonNode.Parse(merged.Content)));
    }

    [Fact]
    public void BothSidesChangingAValueNamesItsPointerAndTakesTheChosenSide()
    {
        const string before = """{"name":"A","tags":[{"id":"x","v":1}],"a/b":1}""";
        const string local = """{"name":"Local","tags":[{"id":"x","v":2}],"a/b":2}""";
        const string current = """{"name":"Server","tags":[{"id":"x","v":3}],"a/b":3}""";
        var detected = Resolve(before, local, current);
        Assert.Equal(["/a~1b", "/name", "/tags/\"x\"/v"], detected.Conflicts.Select(conflict => conflict.Id).Order(StringComparer.Ordinal));
        Assert.Equal(("\"Local\"", "\"Server\""), (detected.Conflicts.Single(c => c.Id == "/name").Local, detected.Conflicts.Single(c => c.Id == "/name").Server));
        Assert.Equal("Server", JsonNode.Parse(detected.Content)!["name"]!.GetValue<string>());
        var chosen = Resolve(before, local, current, new() { ["/name"] = SharedFileMerge.KeepLocal, ["/tags/\"x\"/v"] = "server" });
        var result = JsonNode.Parse(chosen.Content)!;
        Assert.Equal(("Local", 3, 3), (result["name"]!.GetValue<string>(), result["tags"]![0]!["v"]!.GetValue<int>(), result["a/b"]!.GetValue<int>()));
    }

    [Fact]
    public void ARemovedValueChangedOnTheOtherSideIsAConflict()
    {
        var removedLocally = Resolve("""{"a":1}""", "{}", """{"a":2}""");
        Assert.Equal((null, "2"), (removedLocally.Conflicts.Single().Local, removedLocally.Conflicts.Single().Server));
        Assert.Equal("{\"a\":2}", Encoding.UTF8.GetString(removedLocally.Content!));
        var kept = Resolve("""{"a":1}""", "{}", """{"a":2}""", new() { ["/a"] = SharedFileMerge.KeepLocal });
        Assert.Equal("{}", Encoding.UTF8.GetString(kept.Content!));
        Assert.Equal("/", Assert.Single(Resolve("1", "2", "3").Conflicts).Id);
    }

    [Fact]
    public void FilesThatAreNotJsonOrMissingOnOneSideAreChosenWhole()
    {
        var text = SharedFileMerge.Resolve(new("Research/note.txt", Bytes("base"), Bytes("mine")), Bytes("theirs"), null);
        Assert.Equal(new SharedFileConflict(SharedFileMerge.WholeFile, "mine", "theirs"), Assert.Single(text.Conflicts));
        Assert.Equal("theirs", Encoding.UTF8.GetString(text.Content!));
        var deleted = Resolve("{\"a\":1}", null, "{\"a\":2}", new() { [SharedFileMerge.WholeFile] = SharedFileMerge.KeepLocal });
        Assert.Null(deleted.Content);
        Assert.Null(deleted.Conflicts.Single().Local);
    }

    [Fact]
    public void PreviewsOnlyReadableText()
    {
        Assert.Equal("text", SharedFileMerge.Preview(Bytes("text")));
        Assert.Null(SharedFileMerge.Preview(null));
        Assert.Null(SharedFileMerge.Preview([0x41, 0x00]));
        Assert.Null(SharedFileMerge.Preview([0xff, 0xfe, 0xfd]));
        Assert.Null(SharedFileMerge.Preview(new byte[64 * 1024 + 1]));
    }
}
