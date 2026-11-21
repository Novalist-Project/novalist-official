using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Novalist.Sync.Client.Tests;
using Xunit;

namespace Novalist.Backend.Tests;

[Collection("BackendStatics")]
public sealed class PersistentWritingStructureTests
{
    [Fact]
    public async Task ActRenameUpdatesLeasedReferencesAndSupportsUndoAndRedo()
    {
        var ct = TestContext.Current.CancellationToken;
        using var temp = new TempDir();
        await using var identity = await TestIdentityProvider.StartAsync(ct);
        await using var server = await PersistentSessionServer.StartAsync(identity.Authority, ct);
        await using var desktop = new HostedDesktop(Path.Combine(temp.Path, "settings"), identity);
        var projects = desktop.Host.Workspace.Projects;
        await projects.CreateProjectAsync(temp.Path, "Novel", "Book");
        var chapter = await projects.CreateChapterAsync("Opening");
        await projects.CreateSceneAsync(chapter.Guid, "Arrival");
        var book = projects.ActiveBook ?? throw new InvalidOperationException("Missing book.");
        book.Acts = [new() { Name = "Act" }];
        chapter.Act = "Act";
        var entities = new EntityService(projects);
        await entities.SaveCharacterAsync(new()
        {
            Id = "person", Name = "Mira", StateOverrides = [new() { Id = "reference", Act = "Act" }]
        });
        await projects.SaveProjectAsync();
        await desktop.SignInAsync(server.Address);
        await desktop.Rpc.InvokeAsync("collaboration/persistent/create", server.Address);

        var request = new StructureRequest("rename", 0, book.Id, book.ActiveDraftId, new RenameActCommand("Act", "Renamed"));
        var renamed = await desktop.Rpc.InvokeAsync<StructureResult>("writing/structure", request);
        Assert.Equal("committed", renamed.Status);
        Assert.Equal("Renamed", Assert.Single(Assert.Single(await entities.LoadCharactersAsync()).StateOverrides).Act);

        var undone = await desktop.Rpc.InvokeAsync<StructureResult>("writing/undoStructure", renamed.OperationId, 0);
        Assert.Equal("committed", undone.Status);
        Assert.Equal("Act", Assert.Single(Assert.Single(await entities.LoadCharactersAsync()).StateOverrides).Act);

        var redone = await desktop.Rpc.InvokeAsync<StructureResult>("writing/redoStructure", renamed.OperationId, 0);
        Assert.Equal("committed", redone.Status);
        Assert.Equal("Renamed", Assert.Single(Assert.Single(await entities.LoadCharactersAsync()).StateOverrides).Act);
    }
}
