using System.Text.Json;

namespace Novalist.Core.Services;

public partial class ProjectService
{
    internal async Task ReloadWritingStructureAsync()
    {
        var next = CreateStaged(_fileService);
        await next.ReloadSharedProjectAsync();
        CurrentProject = next.CurrentProject;
        ActiveBook = next.ActiveBook;
        ScenesManifest = next.ScenesManifest;
        ProjectSettings = next.ProjectSettings;
    }

    internal ProjectService CreateStaged(IFileService files)
    {
        if (CurrentProject is null || ActiveBook is null || ScenesManifest is null) throw new InvalidOperationException("No project open.");
        var project = CloneStaged(CurrentProject);
        return new ProjectService(files)
        {
            CurrentProject = project,
            ProjectRoot = ProjectRoot,
            ActiveBook = project.Books.Single(book => book.Id == ActiveBook.Id),
            ScenesManifest = CloneStaged(ScenesManifest),
            ProjectSettings = CloneStaged(ProjectSettings)
        };
    }
    private static T CloneStaged<T>(T value) => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(value))
        ?? throw new InvalidDataException("Invalid staged project metadata.");
}
