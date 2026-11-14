using Novalist.Backend.Rpc;
using Novalist.Backend.Tests.TestHelpers;
using Xunit;

namespace Novalist.Backend.Tests;

public sealed class PlanningRpcTests
{
    [Fact]
    public async Task PlanningKeepsEmptyChaptersAndFieldsWithoutReadingSceneFiles()
    {
        using var dir = new TempDir();
        using var workspace = new Workspace(dir.Path);
        await workspace.Projects.CreateProjectAsync(dir.Path, "Project", "Book");
        var empty = await workspace.Projects.CreateChapterAsync("Empty");
        var chapter = await workspace.Projects.CreateChapterAsync("Chapter");
        chapter.Description = "Summary";
        var scene = await workspace.Projects.CreateSceneAsync(chapter.Guid, "Scene");
        scene.Goal = "Goal";
        scene.Outcome = "Outcome";
        scene.Properties = new() { ["custom"] = "Value" };
        File.Delete(workspace.Projects.GetSceneFilePath(chapter, scene));
        var state = new PlanningRpc(workspace).Get();
        Assert.Empty(state.Chapters.Single(c => c.Guid == empty.Guid).Scenes);
        var actual = Assert.Single(state.Chapters.Single(c => c.Guid == chapter.Guid).Scenes);
        Assert.Equal("Goal", actual.Goal);
        Assert.Equal("Outcome", actual.Outcome);
        Assert.Equal("Value", actual.Properties!["custom"]);
        var json = System.Text.Json.JsonSerializer.Serialize(state);
        Assert.DoesNotContain("Html", json);
        Assert.DoesNotContain("Hash", json);
    }
}
