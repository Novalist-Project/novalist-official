using System.Text.Json;
using Novalist.Core.Models;

namespace Novalist.Core.Services;

public sealed class SceneDocumentReader(ProjectService projects, IFileService files)
{
    public async Task<WritingSceneSnapshot> ReadAsync(SceneRef reference, CancellationToken ct = default)
    {
        var document = await ResolveAsync(reference, ct);
        var content = await files.ExistsAsync(document.Path) ? await files.ReadTextAsync(document.Path) : string.Empty;
        ct.ThrowIfCancellationRequested();
        if (FileFrontMatter.TryParse(content, out var identity) && identity.Id != reference.SceneId)
            throw new IOException("The scene identity changed outside Novalist.");
        var html = FileFrontMatter.Strip(content);
        return new(reference, html, ContentHasher.Hash(html), 0);
    }

    public async Task<ResolvedWritingScene> ResolveAsync(SceneRef reference, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        var project = projects.CurrentProject ?? throw new InvalidOperationException("No project open.");
        var book = project.Books.SingleOrDefault(book => book.Id == reference.BookId)
            ?? throw new InvalidOperationException("Unknown book.");
        var draft = book.Drafts.SingleOrDefault(draft => draft.Id == reference.DraftId)
            ?? throw new InvalidOperationException("Unknown draft.");
        var root = projects.ProjectRoot ?? throw new InvalidOperationException("No project open.");
        var draftRoot = ResolveProjectPath(root, book.FolderName, "Drafts", draft.FolderName);
        var active = ReferenceEquals(book, projects.ActiveBook) && draft.Id == book.ActiveDraftId;
        var chapters = active ? book.Chapters : (await ReadMetadataAsync<BookDraftData>(Path.Combine(draftRoot, "draft.json"))).Chapters;
        var manifest = active ? projects.ScenesManifest ?? throw new InvalidDataException("Missing scene manifest.")
            : await ReadMetadataAsync<ScenesManifest>(Path.Combine(draftRoot, "scenes.json"));
        var chapter = chapters.SingleOrDefault(chapter => chapter.Guid == reference.ChapterGuid)
            ?? throw new InvalidOperationException("Unknown chapter.");
        var scene = manifest.Chapters.GetValueOrDefault(chapter.Guid)?.SingleOrDefault(scene => scene.Id == reference.SceneId)
            ?? throw new InvalidOperationException("Unknown scene.");
        ct.ThrowIfCancellationRequested();
        var path = ResolveProjectPath(draftRoot, book.ChapterFolder, chapter.FolderName, scene.FileName);
        return new(reference, book, chapter, scene, manifest, draftRoot, path);
    }

    private async Task<T> ReadMetadataAsync<T>(string path)
        => JsonSerializer.Deserialize<T>(await files.ReadTextAsync(path))
            ?? throw new InvalidDataException("Invalid writing metadata.");

    internal static string ResolveProjectPath(string root, params string[] parts)
    {
        var fullRoot = Path.GetFullPath(root);
        var path = Path.GetFullPath(Path.Combine([fullRoot, .. parts]));
        if (!path.StartsWith(Path.TrimEndingDirectorySeparator(fullRoot) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Writing files must remain inside the project.");
        return path;
    }
}

public sealed record ResolvedWritingScene(SceneRef Ref, BookData Book, ChapterData Chapter, SceneData Scene,
    ScenesManifest Manifest, string DraftRoot, string Path);
