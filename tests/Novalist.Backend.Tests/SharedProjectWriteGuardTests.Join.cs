using System.Text;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed partial class SharedProjectWriteGuardTests
{
    // Opening a joined project can rewrite shared files before collaboration attaches,
    // e.g. a locally installed extension registering an entity type the host lacks.
    private static Task RegisterLocalExtensionTypeAsync(SharedProjectFixture fixture) =>
        new EntityService(fixture.Host.Workspace.Projects).SaveCustomEntityTypeAsync(new CustomEntityTypeDefinition
        {
            TypeKey = "ext.joiner.faction",
            DisplayName = "Faction",
            DisplayNamePlural = "Factions",
            FolderName = "Factions",
            Source = "extension"
        });

    // A research item gives project.json shared metadata bindings, so a rewrite of
    // project.json on open trips the source-hash check that used to fail every join.
    private static async Task<SharedProjectFixture> StartWithProjectBindingsAsync()
    {
        var fixture = await SharedProjectFixture.StartAsync(attach: false);
        try
        {
            await fixture.Desktop.InvokeAsync("research/save", null, "Source", "Note", "Writing.txt", Array.Empty<string>(), Array.Empty<string>());
            await fixture.CaptureAsync();
            Assert.Contains(fixture.State.Fields, field => field.Path == ".novalist/project.json");
            return fixture;
        }
        catch { await fixture.DisposeAsync(); throw; }
    }

    [Fact]
    public async Task HostAttachStillRejectsSharedMetadataChangedAfterCapture()
    {
        await using var fixture = await StartWithProjectBindingsAsync();
        await RegisterLocalExtensionTypeAsync(fixture);

        var error = await Assert.ThrowsAsync<IOException>(() => fixture.AttachAsync(fixture.State));
        Assert.Contains("changed", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task JoiningAfterOpenRegisteredAnEntityTypeSucceedsAndPublishesTheType()
    {
        await using var fixture = await StartWithProjectBindingsAsync();
        await RegisterLocalExtensionTypeAsync(fixture);

        await fixture.AttachAsync(fixture.State, joining: true);
        Assert.True(await fixture.Desktop.InvokeAsync<bool>("system/barrier"));

        var committed = await fixture.ReadCommittedFilesAsync();
        Assert.Contains("ext.joiner.faction", Encoding.UTF8.GetString(committed[".novalist/project.json"]), StringComparison.Ordinal);
        Assert.True(await fixture.Desktop.InvokeAsync<bool>("system/barrier"));
    }

    [Fact]
    public async Task JoiningWithoutChangesOnOpenPublishesNothing()
    {
        await using var fixture = await StartWithProjectBindingsAsync();
        var sequence = fixture.Updates.CommittedSequence;

        await fixture.AttachAsync(fixture.State, joining: true);
        Assert.True(await fixture.Desktop.InvokeAsync<bool>("system/barrier"));

        Assert.Equal(sequence, fixture.Updates.CommittedSequence);
    }
}
