using Novalist.Core.Services;
using Xunit;

namespace Novalist.Sync.Client.Tests;

public sealed class CheckpointCaptureRaceTests : IDisposable
{
    private const string ProjectPath = ".novalist/project.json";
    private const string FactionPath = "World Bible/Factions/one.json";
    private readonly string root = Path.Combine(Path.GetTempPath(), "novalist-checkpoint-race-tests", Guid.NewGuid().ToString("N"));

    private async Task<string> CreateSourceAsync(CancellationToken ct)
    {
        var source = Path.Combine(root, "owner");
        Directory.CreateDirectory(Path.Combine(source, ".novalist"));
        Directory.CreateDirectory(Path.Combine(source, "World Bible/Factions"));
        await File.WriteAllTextAsync(Path.Combine(source, ProjectPath),
            """{"books":[],"worldBibleFolder":"World Bible","researchItems":[{"id":"note","type":"Note","title":"Source"}],"customEntityTypes":[{"typeKey":"faction","folderName":"Factions","defaultFields":[]}]}""", ct);
        await File.WriteAllTextAsync(Path.Combine(source, FactionPath), """{"id":"one","name":"Faction","fields":{"motto":"old"}}""", ct);
        return source;
    }

    // Saves replace the file atomically, like FileService does, so an open reader keeps the old bytes.
    private static void ReplaceAtomically(string source, string relative, string content)
    {
        var path = Path.Combine(source, relative);
        var temporary = path + ".tmp";
        File.WriteAllText(temporary, content);
        File.Move(temporary, path, overwrite: true);
    }

    [Fact]
    public async Task SavesLandingAfterFilesWereArchivedKeepTheCheckpointConsistent()
    {
        var ct = TestContext.Current.CancellationToken;
        var source = await CreateSourceAsync(ct);
        var paths = ProjectContentSelection.Read(source);
        var fields = await SharedCodexFields.CaptureAsync(source, paths, ct);
        Assert.Contains(fields, field => field.Path == ProjectPath);
        Assert.Contains(fields, field => field.Path == FactionPath);
        var calls = 0;
        IReadOnlyList<string> SelectAndSaveAfterArchiving()
        {
            // The second call runs once every file is in the archive.
            if (++calls == 2)
            {
                ReplaceAtomically(source, ProjectPath, """{"books":[],"worldBibleFolder":"World Bible","researchItems":[{"id":"note","type":"Note","title":"Changed"}],"customEntityTypes":[{"typeKey":"faction","folderName":"Factions","defaultFields":[]}]}""");
                ReplaceAtomically(source, FactionPath, """{"id":"one","name":"Renamed","fields":{"motto":"new"}}""");
            }
            return paths;
        }

        using var archive = new MemoryStream();
        await ProjectCheckpoint.CreateAsync(source, archive, SelectAndSaveAfterArchiving, new SharedProjectState([], fields), ct);
        archive.Position = 0;
        var destination = Path.Combine(root, "joined");
        var installed = await ProjectCheckpoint.InstallAsync(archive, destination, 1024 * 1024, ct);
        var values = await SharedCodexFields.ReadAsync(destination, installed.Fields, ct);

        Assert.Equal(2, calls);
        Assert.Equal("Faction", values[Assert.Single(fields, field => field.Path == FactionPath && field.Key == "name").ItemId]);
        Assert.Equal("old", values[Assert.Single(fields, field => field.Path == FactionPath && field.Key == "motto").ItemId]);
    }

    [Fact]
    public async Task AFileChangedBeforeItWasArchivedStillFailsTheCheckpoint()
    {
        var ct = TestContext.Current.CancellationToken;
        var source = await CreateSourceAsync(ct);
        var paths = ProjectContentSelection.Read(source);
        var fields = await SharedCodexFields.CaptureAsync(source, paths, ct);
        ReplaceAtomically(source, FactionPath, """{"id":"one","name":"Renamed","fields":{"motto":"new"}}""");

        using var archive = new MemoryStream();
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            ProjectCheckpoint.CreateAsync(source, archive, () => paths, new SharedProjectState([], fields), ct));
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }
}
