using System.Text;
using System.Text.Json.Nodes;
using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Novalist.Sync.Client;
using Novalist.Sync.Client.Tests;
using StreamJsonRpc;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed class PersistentProjectMergeTests
{
    [Fact]
    public async Task WritingDoneWhileDisconnectedMergesWithOtherWritersChanges()
    {
        await using var shared = await SharedProject.StartAsync();
        await shared.GuestWriteSceneAsync(shared.Second, "<p>Guest second.</p>");
        await shared.Guest.Rpc.InvokeAsync("collaboration/end");

        await shared.WriteSceneAsync(shared.OwnerRoot, shared.First, "<p>Owner first.</p>");
        await File.WriteAllTextAsync(shared.Research(shared.OwnerRoot, "note.txt"), "Owner note.");
        await File.WriteAllTextAsync(shared.Research(shared.OwnerRoot, "added.txt"), "Added offline.");
        File.Delete(shared.Research(shared.OwnerRoot, "gone.txt"));
        await shared.EditCharacterAsync(shared.OwnerRoot, age: "31", description: "Tall and quiet.");
        var resumed = await shared.Owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/resume");
        Assert.Equal(0, resumed.Conflicts);
        Assert.Empty(await shared.Owner.Rpc.InvokeAsync<SharedMergeConflictDto[]>("collaboration/persistent/conflicts"));
        Assert.Equal("<p>Owner first.</p>", await shared.ReadSceneAsync(shared.Owner, shared.First));
        Assert.Equal("<p>Guest second.</p>", await shared.ReadSceneAsync(shared.Owner, shared.Second));
        await shared.Owner.Rpc.InvokeAsync("collaboration/end");

        await shared.Guest.Rpc.InvokeAsync("collaboration/persistent/resume");
        Assert.Equal("<p>Owner first.</p>", await shared.ReadSceneAsync(shared.Guest, shared.First));
        Assert.Equal("Owner note.", await File.ReadAllTextAsync(shared.Research(shared.GuestRoot, "note.txt")));
        Assert.Equal("Added offline.", await File.ReadAllTextAsync(shared.Research(shared.GuestRoot, "added.txt")));
        Assert.False(File.Exists(shared.Research(shared.GuestRoot, "gone.txt")));
        var character = await shared.ReadCharacterAsync(shared.GuestRoot);
        Assert.Equal("31", character["age"]?.GetValue<string>());
        Assert.Equal("Tall and quiet.", character["distinguishingFeatures"]?.GetValue<string>());
        await shared.Guest.Rpc.InvokeAsync("collaboration/end");
    }

    [Fact]
    public async Task ConflictsWaitForAChoiceAndAreAskedAgainAfterARestart()
    {
        await using var shared = await SharedProject.StartAsync();
        await shared.GuestWriteSceneAsync(shared.First, "<p>Guest first.</p>");
        await shared.Guest.Rpc.InvokeAsync("collaboration/end");
        await File.WriteAllTextAsync(shared.Research(shared.GuestRoot, "note.txt"), "Guest note.");
        await File.WriteAllTextAsync(shared.Research(shared.GuestRoot, "data.json"), """{"name":5,"value":"guest"}""");
        await shared.EditCharacterAsync(shared.GuestRoot, age: "40", description: "Guest description.");
        Assert.Equal(0, (await shared.Guest.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/resume")).Conflicts);
        await shared.Guest.Rpc.InvokeAsync("collaboration/end");

        await shared.WriteSceneAsync(shared.OwnerRoot, shared.First, "<p>Owner first.</p>");
        await File.WriteAllTextAsync(shared.Research(shared.OwnerRoot, "note.txt"), "Owner note.");
        await File.WriteAllTextAsync(shared.Research(shared.OwnerRoot, "data.json"), """{"name":5,"value":"owner"}""");
        await File.WriteAllTextAsync(shared.Research(shared.OwnerRoot, "added.txt"), "Clean change beside the conflicts.");
        await shared.EditCharacterAsync(shared.OwnerRoot, age: "50", description: "Owner description.");
        var resumed = await shared.Owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/resume");
        Assert.Equal(5, resumed.Conflicts);
        var conflicts = await shared.Owner.Rpc.InvokeAsync<SharedMergeConflictDto[]>("collaboration/persistent/conflicts");
        var scene = Assert.Single(conflicts, conflict => conflict.Path.EndsWith(".md", StringComparison.Ordinal) || conflict.Label.Contains("Arrival", StringComparison.Ordinal));
        Assert.Equal(("prose", "<p>Owner first.</p>", "<p>Guest first.</p>"), (scene.Kind, scene.Local, scene.Server));
        Assert.Equal("Opening · Arrival", scene.Label);
        var note = Assert.Single(conflicts, conflict => conflict.Path.EndsWith("note.txt", StringComparison.Ordinal));
        Assert.Equal(("file", "note.txt", "Owner note.", "Guest note."), (note.Kind, note.Label, note.Local, note.Server));
        var data = Assert.Single(conflicts, conflict => conflict.Path.EndsWith("data.json", StringComparison.Ordinal));
        Assert.Equal(("structure", "/value", "data.json", "\"owner\"", "\"guest\""), (data.Kind, data.Id, data.Label, data.Local, data.Server));
        var age = Assert.Single(conflicts, conflict => conflict.Kind == "field");
        Assert.Equal(("Mira · age", "50", "40"), (age.Label, age.Local, age.Server));
        var description = Assert.Single(conflicts, conflict => conflict.Kind == "prose" && conflict != scene);
        Assert.Equal(("Owner description.", "Guest description."), (description.Local, description.Server));
        Assert.Equal("<p>Guest first.</p>", await shared.ReadSceneAsync(shared.Owner, shared.First));
        Assert.Equal("Clean change beside the conflicts.", await File.ReadAllTextAsync(shared.Research(shared.OwnerRoot, "added.txt")));

        await shared.Owner.Rpc.InvokeAsync("collaboration/end");
        Assert.Equal(5, (await shared.Owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/resume")).Conflicts);
        await Assert.ThrowsAsync<RemoteInvocationException>(() => shared.Owner.Rpc.InvokeAsync("collaboration/persistent/resolveConflicts",
            new object[] { new[] { new SharedMergeChoiceDto(scene.Path, scene.Id, "mine") } }));
        var choices = new[]
        {
            new SharedMergeChoiceDto(scene.Path, scene.Id, "local"), new SharedMergeChoiceDto(age.Path, age.Id, "local"),
            new SharedMergeChoiceDto(data.Path, data.Id, "local"), new SharedMergeChoiceDto(note.Path, note.Id, "server"),
            new SharedMergeChoiceDto(description.Path, description.Id, "server")
        };
        var resolved = await shared.Owner.Rpc.InvokeAsync<HostedSessionDto>("collaboration/persistent/resolveConflicts", new object[] { choices });
        Assert.Equal(0, resolved.Conflicts);
        Assert.Empty(await shared.Owner.Rpc.InvokeAsync<SharedMergeConflictDto[]>("collaboration/persistent/conflicts"));
        await Assert.ThrowsAsync<RemoteInvocationException>(() => shared.Owner.Rpc.InvokeAsync("collaboration/persistent/resolveConflicts",
            new object[] { Array.Empty<SharedMergeChoiceDto>() }));
        await shared.Owner.Rpc.InvokeAsync("collaboration/end");
        await Assert.ThrowsAsync<RemoteInvocationException>(() => shared.Owner.Rpc.InvokeAsync("collaboration/persistent/resolveConflicts",
            new object[] { Array.Empty<SharedMergeChoiceDto>() }));

        await shared.Guest.Rpc.InvokeAsync("collaboration/persistent/resume");
        Assert.Equal("<p>Owner first.</p>", await shared.ReadSceneAsync(shared.Guest, shared.First));
        Assert.Equal("Guest note.", await File.ReadAllTextAsync(shared.Research(shared.GuestRoot, "note.txt")));
        Assert.Equal("owner", JsonNode.Parse(await File.ReadAllTextAsync(shared.Research(shared.GuestRoot, "data.json")))!["value"]!.GetValue<string>());
        var character = await shared.ReadCharacterAsync(shared.GuestRoot);
        Assert.Equal("50", character["age"]?.GetValue<string>());
        Assert.Equal("Guest description.", character["distinguishingFeatures"]?.GetValue<string>());
        await shared.Guest.Rpc.InvokeAsync("collaboration/end");
    }

    [Fact]
    public async Task FilesAddedOrDeletedOnOneSideAndChangedOnTheOtherAreConflicts()
    {
        await using var shared = await SharedProject.StartAsync();
        await shared.Guest.Rpc.InvokeAsync("collaboration/end");
        File.Delete(shared.Research(shared.GuestRoot, "note.txt"));
        await File.WriteAllTextAsync(shared.Research(shared.GuestRoot, "gone.txt"), "Guest kept this.");
        await File.WriteAllTextAsync(shared.Research(shared.GuestRoot, "both.txt"), "Guest addition.");
        await File.WriteAllTextAsync(shared.Research(shared.GuestRoot, "same.txt"), "Same addition.");
        await shared.Guest.Rpc.InvokeAsync("collaboration/persistent/resume");
        await shared.Guest.Rpc.InvokeAsync("collaboration/end");

        await File.WriteAllTextAsync(shared.Research(shared.OwnerRoot, "note.txt"), "Owner kept this.");
        File.Delete(shared.Research(shared.OwnerRoot, "gone.txt"));
        await File.WriteAllTextAsync(shared.Research(shared.OwnerRoot, "both.txt"), "Owner addition.");
        await File.WriteAllTextAsync(shared.Research(shared.OwnerRoot, "same.txt"), "Same addition.");
        await shared.Owner.Rpc.InvokeAsync("collaboration/persistent/resume");
        var conflicts = await shared.Owner.Rpc.InvokeAsync<SharedMergeConflictDto[]>("collaboration/persistent/conflicts");
        Assert.Equal(["both.txt", "gone.txt", "note.txt"], conflicts.Select(conflict => Path.GetFileName(conflict.Path)).Order());
        Assert.All(conflicts, conflict => Assert.Equal(("file", SharedFileMerge.WholeFile), (conflict.Kind, conflict.Id)));
        Assert.Null(Assert.Single(conflicts, conflict => conflict.Path.EndsWith("gone.txt", StringComparison.Ordinal)).Local);
        Assert.Null(Assert.Single(conflicts, conflict => conflict.Path.EndsWith("note.txt", StringComparison.Ordinal)).Server);
        await shared.Owner.Rpc.InvokeAsync("collaboration/persistent/resolveConflicts",
            new object[] { conflicts.Select(conflict => new SharedMergeChoiceDto(conflict.Path, conflict.Id, "local")).ToArray() });
        Assert.Equal("Owner kept this.", await File.ReadAllTextAsync(shared.Research(shared.OwnerRoot, "note.txt")));
        Assert.False(File.Exists(shared.Research(shared.OwnerRoot, "gone.txt")));
        Assert.Equal("Owner addition.", await File.ReadAllTextAsync(shared.Research(shared.OwnerRoot, "both.txt")));
        await shared.Owner.Rpc.InvokeAsync("collaboration/end");
        await shared.Guest.Rpc.InvokeAsync("collaboration/persistent/resume");
        Assert.Equal("Owner kept this.", await File.ReadAllTextAsync(shared.Research(shared.GuestRoot, "note.txt")));
        Assert.False(File.Exists(shared.Research(shared.GuestRoot, "gone.txt")));
        Assert.Equal("Owner addition.", await File.ReadAllTextAsync(shared.Research(shared.GuestRoot, "both.txt")));
        await shared.Guest.Rpc.InvokeAsync("collaboration/end");
    }

    [Fact]
    public async Task WithoutASavedBaseEveryDifferenceIsOfferedWhole()
    {
        await using var shared = await SharedProject.StartAsync();
        await shared.GuestWriteSceneAsync(shared.Second, "<p>Guest second.</p>");
        await shared.Guest.Rpc.InvokeAsync("collaboration/end");
        foreach (var file in shared.OwnerStorage("*.base.*")) File.Delete(file);

        await shared.WriteSceneAsync(shared.OwnerRoot, shared.First, "<p>Owner first.</p>");
        await shared.EditCharacterAsync(shared.OwnerRoot, age: "33", description: "Owner description.");
        await shared.Owner.Rpc.InvokeAsync("collaboration/persistent/resume");
        var conflicts = await shared.Owner.Rpc.InvokeAsync<SharedMergeConflictDto[]>("collaboration/persistent/conflicts");
        Assert.All(conflicts, conflict => Assert.Equal("file", conflict.Kind));
        Assert.Contains(conflicts, conflict => conflict.Label == "Opening · Arrival");
        Assert.Contains(conflicts, conflict => conflict.Label == "Mira");
        Assert.Contains(conflicts, conflict => conflict.Label == "Opening · Departure");
        await shared.Owner.Rpc.InvokeAsync("collaboration/persistent/resolveConflicts", new object[]
        {
            conflicts.Select(conflict => new SharedMergeChoiceDto(conflict.Path, conflict.Id, conflict.Label == "Opening · Departure" ? "server" : "local")).ToArray()
        });
        Assert.Equal("<p>Owner first.</p>", await shared.ReadSceneAsync(shared.Owner, shared.First));
        Assert.Equal("<p>Guest second.</p>", await shared.ReadSceneAsync(shared.Owner, shared.Second));
        var character = await shared.ReadCharacterAsync(shared.OwnerRoot);
        Assert.Equal(("33", "Owner description."), (character["age"]?.GetValue<string>(), character["distinguishingFeatures"]?.GetValue<string>()));
        await shared.Owner.Rpc.InvokeAsync("collaboration/end");
    }

    [Fact]
    public async Task ADocumentWithoutSavedStateAndAnUnreadableLocalFieldStillMerge()
    {
        await using var shared = await SharedProject.StartAsync();
        await shared.Guest.Rpc.InvokeAsync("collaboration/end");
        var documents = Assert.Single(shared.OwnerStorage("*.base.json"));
        await File.WriteAllTextAsync(documents, """{"Version":1,"Documents":{}}""");
        await shared.WriteSceneAsync(shared.OwnerRoot, shared.First, "<p>Owner first.</p>");
        var character = await shared.ReadCharacterAsync(shared.OwnerRoot);
        character["age"] = 31;
        character["distinguishingFeatures"] = "Owner description.";
        await File.WriteAllTextAsync(Path.Combine(shared.OwnerRoot, "Book", "Characters", shared.EntityId + ".json"), character.ToJsonString());
        await shared.Owner.Rpc.InvokeAsync("collaboration/persistent/resume");
        var conflicts = await shared.Owner.Rpc.InvokeAsync<SharedMergeConflictDto[]>("collaboration/persistent/conflicts");
        Assert.All(conflicts, conflict => Assert.Equal("prose", conflict.Kind));
        if (conflicts.Length > 0) await shared.Owner.Rpc.InvokeAsync("collaboration/persistent/resolveConflicts",
            new object[] { conflicts.Select(conflict => new SharedMergeChoiceDto(conflict.Path, conflict.Id, "local")).ToArray() });
        Assert.Equal("<p>Owner first.</p>", await shared.ReadSceneAsync(shared.Owner, shared.First));
        var merged = await shared.ReadCharacterAsync(shared.OwnerRoot);
        Assert.Equal(("30", "Owner description."), (merged["age"]?.GetValue<string>(), merged["distinguishingFeatures"]?.GetValue<string>()));
        await shared.Owner.Rpc.InvokeAsync("collaboration/end");
    }

    [Fact]
    public async Task InvalidSavedMergeStateStopsReconnectingWithoutTouchingLocalWriting()
    {
        await using var shared = await SharedProject.StartAsync();
        await shared.Guest.Rpc.InvokeAsync("collaboration/end");
        await shared.WriteSceneAsync(shared.OwnerRoot, shared.First, "<p>Owner first.</p>");
        var scene = shared.Project.GetSceneFilePath(shared.Chapter, shared.First);
        var local = await File.ReadAllTextAsync(scene);
        var documents = Assert.Single(shared.OwnerStorage("*.base.json"));
        var saved = await File.ReadAllTextAsync(documents);
        await File.WriteAllTextAsync(documents, """{"Version":2,"Documents":{}}""");
        await Assert.ThrowsAsync<RemoteInvocationException>(() => shared.Owner.Rpc.InvokeAsync("collaboration/persistent/resume"));
        Assert.Equal(local, await File.ReadAllTextAsync(scene));
        await File.WriteAllTextAsync(documents, saved);
        await File.WriteAllTextAsync(Path.ChangeExtension(documents, null).Replace(".base", ".pending.json", StringComparison.Ordinal), """{"Version":2}""");
        await Assert.ThrowsAsync<RemoteInvocationException>(() => shared.Owner.Rpc.InvokeAsync("collaboration/persistent/resume"));
        Assert.Equal(local, await File.ReadAllTextAsync(scene));
    }

    [Fact]
    public async Task AFieldHeldByAnotherWriterKeepsTheirValueAndSavesThisDevicesValueAside()
    {
        await using var shared = await SharedProject.StartAsync();
        await shared.Guest.Rpc.InvokeAsync("collaboration/end");
        await shared.EditCharacterAsync(shared.GuestRoot, age: "40", description: "Tall.");
        await shared.Guest.Rpc.InvokeAsync("collaboration/persistent/resume");
        await shared.EditCharacterAsync(shared.OwnerRoot, age: "50", description: "Tall.");
        await shared.Owner.Rpc.InvokeAsync("collaboration/persistent/resume");
        var age = Assert.Single(await shared.Owner.Rpc.InvokeAsync<SharedMergeConflictDto[]>("collaboration/persistent/conflicts"));
        var guestSession = (await shared.Guest.Rpc.InvokeAsync<HostedSessionDto>("collaboration/status")).SessionId;
        var guestFields = shared.Guest.Host.Workspace.SharedEntityFields(new CharacterData { Id = shared.EntityId })!;
        var focus = Guid.NewGuid();
        await shared.Guest.Rpc.InvokeAsync<object>("collaboration/acquireField", guestSession, guestFields.Fields["age"], focus);
        await shared.Owner.Rpc.InvokeAsync("collaboration/persistent/resolveConflicts",
            new object[] { new[] { new SharedMergeChoiceDto(age.Path, age.Id, "local") } });
        Assert.Equal("40", (await shared.ReadCharacterAsync(shared.OwnerRoot))["age"]?.GetValue<string>());
        var recovered = Directory.GetFiles(Path.Combine(shared.OwnerRoot, "Recovered edits"), "*.json", SearchOption.AllDirectories);
        Assert.Contains(recovered, path => File.ReadAllText(path).Contains("\"50\"", StringComparison.Ordinal));
        await shared.Guest.Rpc.InvokeAsync("collaboration/releaseField", guestSession, guestFields.Fields["age"], focus);
        await shared.Guest.Rpc.InvokeAsync("collaboration/end");
        await shared.Owner.Rpc.InvokeAsync("collaboration/end");
    }

    [Fact]
    public async Task AFailedBaseSaveDoesNotStopEndingTheSession()
    {
        await using var shared = await SharedProject.StartAsync();
        await shared.Guest.Rpc.InvokeAsync("collaboration/end");
        await shared.Owner.Rpc.InvokeAsync("collaboration/persistent/resume");
        var archive = Assert.Single(shared.OwnerStorage("*.base.zip"));
        File.Delete(archive);
        Directory.CreateDirectory(archive);
        Directory.CreateDirectory(Path.Combine(archive, "blocked"));
        await shared.Owner.Rpc.InvokeAsync("collaboration/end");
        Assert.Null(await shared.Owner.Rpc.InvokeAsync<HostedSessionDto?>("collaboration/status"));
    }

    private sealed class SharedProject : IAsyncDisposable
    {
        private readonly TempDir temp = new();
        private TestIdentityProvider identity = null!;
        private PersistentSessionServer server = null!;
        internal HostedDesktop Owner { get; private set; } = null!;
        internal HostedDesktop Guest { get; private set; } = null!;
        internal ProjectService Project { get; } = new(new FileService());
        internal ChapterData Chapter { get; private set; } = null!;
        internal SceneData First { get; private set; } = null!;
        internal SceneData Second { get; private set; } = null!;
        internal string EntityId { get; } = Guid.NewGuid().ToString();
        internal string OwnerRoot => Project.ProjectRoot!;
        internal string GuestRoot => Path.Combine(temp.Path, "Joined");

        internal static async Task<SharedProject> StartAsync()
        {
            var shared = new SharedProject();
            await shared.InitializeAsync(TestContext.Current.CancellationToken);
            return shared;
        }

        private async Task InitializeAsync(CancellationToken ct)
        {
            identity = await TestIdentityProvider.StartAsync(ct);
            server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
            Owner = new HostedDesktop(Path.Combine(temp.Path, "owner"), identity);
            await Project.CreateProjectAsync(temp.Path, "Novel", "Book");
            Chapter = await Project.CreateChapterAsync("Opening");
            First = await Project.CreateSceneAsync(Chapter.Guid, "Arrival");
            Second = await Project.CreateSceneAsync(Chapter.Guid, "Departure");
            await new EntityService(Project).SaveCharacterAsync(new() { Id = EntityId, Name = "Mira", Age = "30", DistinguishingFeatures = "Tall." });
            Directory.CreateDirectory(Path.Combine(OwnerRoot, "Research"));
            await File.WriteAllTextAsync(Research(OwnerRoot, "note.txt"), "Base note.", ct);
            await File.WriteAllTextAsync(Research(OwnerRoot, "gone.txt"), "Deleted offline.", ct);
            await File.WriteAllTextAsync(Research(OwnerRoot, "data.json"), """{"name":5,"value":"base"}""", ct);
            await Owner.Rpc.InvokeAsync("project/open", OwnerRoot);
            await Owner.SignInAsync(server.Address);
            await Owner.Rpc.InvokeAsync("collaboration/persistent/create", server.Address);
            var link = await Owner.Rpc.InvokeAsync<string>("collaboration/invite", DateTimeOffset.UtcNow.AddHours(1));
            await Owner.Rpc.InvokeAsync("collaboration/end");
            identity.Subject = "guest";
            identity.IssueAccessToken = () => "guest-token";
            Guest = new HostedDesktop(Path.Combine(temp.Path, "guest"), identity);
            await Guest.SignInAsync(server.Address);
            await Guest.Rpc.InvokeAsync("collaboration/persistent/join", server.Address, link, GuestRoot);
        }

        internal string Research(string root, string name) => Path.Combine(root, "Research", name);

        internal string[] OwnerStorage(string pattern) =>
            Directory.GetFiles(Path.Combine(temp.Path, "owner", "Collaboration", "persistent", "merge"), pattern);

        internal Task WriteSceneAsync(string root, SceneData scene, string html) => File.WriteAllTextAsync(
            Path.Combine(root, Path.GetRelativePath(OwnerRoot, Project.GetSceneFilePath(Chapter, scene))), FileFrontMatter.Stamp(html, scene.Id));

        internal async Task GuestWriteSceneAsync(SceneData scene, string html)
        {
            var session = (await Guest.Rpc.InvokeAsync<HostedSessionDto>("collaboration/status")).SessionId;
            var content = await Guest.Rpc.InvokeAsync<SceneContentDto>("scenes/read", Chapter.Guid, scene.Id);
            await Guest.Rpc.InvokeAsync("collaboration/writeScene", session, content.Shared!.ItemId, Encoding.UTF8.GetBytes(html));
        }

        internal async Task<string?> ReadSceneAsync(HostedDesktop desktop, SceneData scene) =>
            (await desktop.Rpc.InvokeAsync<SceneContentDto>("scenes/read", Chapter.Guid, scene.Id)).Html;

        private string CharacterPath(string root) => Path.Combine(root, "Book", "Characters", EntityId + ".json");

        internal async Task<JsonObject> ReadCharacterAsync(string root) => (JsonObject)JsonNode.Parse(await File.ReadAllTextAsync(CharacterPath(root)))!;

        internal async Task EditCharacterAsync(string root, string age, string description)
        {
            var character = await ReadCharacterAsync(root);
            character["age"] = age;
            character["distinguishingFeatures"] = description;
            await File.WriteAllTextAsync(CharacterPath(root), character.ToJsonString());
        }

        public async ValueTask DisposeAsync()
        {
            if (Guest is not null) await Guest.DisposeAsync();
            if (Owner is not null) await Owner.DisposeAsync();
            if (server is not null) await server.DisposeAsync();
            if (identity is not null) await identity.DisposeAsync();
            temp.Dispose();
        }
    }
}
