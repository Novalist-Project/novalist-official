using System.Text.Json;
using Novalist.Core.Models;

namespace Novalist.Core.Services;

public sealed class WritingSearchCatalog(ProjectService projects, IFileService files)
{
    public async Task<WritingSearchTarget[]> ReadAsync(string bookId, string draftId, bool projectWide, CancellationToken ct)
    {
        var project = projects.CurrentProject ?? throw new InvalidOperationException("No project open.");
        var targets = new List<WritingSearchTarget>();
        foreach (var book in project.Books.Where(book => projectWide || book.Id == bookId))
        {
            ct.ThrowIfCancellationRequested();
            var id = book.Id == bookId ? draftId : book.ActiveDraftId;
            var draft = book.Drafts.Single(draft => draft.Id == id);
            var projectRoot = projects.ProjectRoot ?? throw new InvalidOperationException("No project open.");
            var root = SceneDocumentReader.ResolveProjectPath(projectRoot, book.FolderName, "Drafts", draft.FolderName);
            var active = ReferenceEquals(book, projects.ActiveBook) && draft.Id == book.ActiveDraftId;
            var chapters = active ? book.Chapters : (await ReadAsync<BookDraftData>(root, "draft.json")).Chapters;
            var manifest = active ? projects.ScenesManifest ?? throw new InvalidDataException("Missing scene manifest.") : await ReadAsync<ScenesManifest>(root, "scenes.json");
            foreach (var chapter in chapters.OrderBy(chapter => chapter.Order))
                foreach (var scene in (manifest.Chapters.GetValueOrDefault(chapter.Guid) ?? []).OrderBy(scene => scene.Order))
                    targets.Add(new(new(book.Id, draft.Id, chapter.Guid, scene.Id), book.Name, chapter.Title, scene.Title));
        }
        return targets.ToArray();
    }

    private async Task<T> ReadAsync<T>(string root, string name)
        => JsonSerializer.Deserialize<T>(await files.ReadTextAsync(Path.Combine(root, name)))
            ?? throw new InvalidDataException("Invalid writing metadata.");
}
