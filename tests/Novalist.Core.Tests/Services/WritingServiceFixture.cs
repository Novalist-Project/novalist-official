using Novalist.Core.Models;
using Novalist.Core.Services;
using Novalist.Core.Tests.TestHelpers;

namespace Novalist.Core.Tests.Services;

internal sealed class WritingServiceFixture : IDisposable
{
    private readonly TempDir _directory = new();
    public FileService Files { get; } = new();
    public ProjectService Projects { get; }
    public SceneDocumentReader Reader { get; }

    public WritingServiceFixture()
    {
        Projects = new(Files);
        Reader = new(Projects, Files);
    }

    public async Task<SceneRef> CreateAsync()
    {
        await Projects.CreateProjectAsync(_directory.Path, "Novel", "First");
        return await AddSceneAsync("Opening", "Before");
    }

    public async Task<SceneRef> AddSceneAsync(string title, string html)
    {
        var chapter = await Projects.CreateChapterAsync(title);
        var scene = await Projects.CreateSceneAsync(chapter.Guid, title);
        await Projects.WriteSceneContentAsync(chapter, scene, html);
        return new(Projects.ActiveBook!.Id, Projects.ActiveBook.ActiveDraftId!, chapter.Guid, scene.Id);
    }

    public void Dispose() => _directory.Dispose();
}
