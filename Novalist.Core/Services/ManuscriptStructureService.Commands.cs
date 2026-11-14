using Novalist.Core.Models;
using Novalist.Core.Utilities;

namespace Novalist.Core.Services;

public sealed partial class ManuscriptStructureService
{
    private static async Task<SceneRef> InsertSceneAsync(ProjectService staged, InsertSceneCommand command)
    {
        RequireTitle(command.Title);
        var scenes = staged.GetScenesForChapter(command.ChapterGuid).OrderBy(scene => scene.Order).ToArray();
        var destination = Destination(scenes.Select(scene => scene.Id).ToArray(), command.BeforeSceneId);
        var created = await staged.CreateSceneAsync(command.ChapterGuid, command.Title.Trim());
        await staged.ReorderSceneAsync(command.ChapterGuid, created.Id, destination + 1);
        return Reference(staged, command.ChapterGuid, created.Id);
    }

    private static async Task<SceneRef> InsertAsync(ProjectService staged, InsertChapterCommand command)
    {
        RequireTitle(command.Title);
        var chapters = staged.GetChaptersOrdered();
        var index = Destination(chapters.Select(chapter => chapter.Guid).ToArray(), command.BeforeChapterGuid);
        var chapter = await staged.CreateChapterAsync(command.Title.Trim(), insertAtOrder: index + 1);
        chapter.Act = RequireAct(staged, command.ActName);
        var scene = await staged.CreateSceneAsync(chapter.Guid, command.Title.Trim());
        if (command.DateRange is not null) await staged.SetChapterDateRangeAsync(chapter.Guid, command.DateRange);
        await staged.SaveProjectAsync();
        return Reference(staged, chapter.Guid, scene.Id);
    }

    private static async Task<SceneRef> SplitAsync(ProjectService staged, SplitSceneCommand command, string? title)
    {
        var (reference, beforeHtml, afterHtml, sourceHtml, expectedHash) = command;
        if (title is not null) RequireTitle(title);
        if (reference.BookId != RequireBook(staged).Id || reference.DraftId != RequireBook(staged).ActiveDraftId)
            throw new InvalidOperationException("writing.workspaceChanged");
        var chapter = staged.GetChaptersOrdered().Single(c => c.Guid == reference.ChapterGuid);
        var original = staged.GetScenesForChapter(chapter.Guid).Single(scene => scene.Id == reference.SceneId);
        var annotations = WritingAnnotations.FromScene(original);
        _ = WritingAnnotationMerge.Merge(annotations, annotations, annotations);
        var actual = await staged.ReadSceneContentAsync(chapter, original);
        if (actual != sourceHtml || ContentHasher.Hash(actual) != expectedHash) throw new WritingConflictException("writing.structureConflict");
        var created = await new SceneSplitService(staged).SplitAsync(chapter.Guid, original.Id, beforeHtml, afterHtml, string.Empty)
            ?? throw new InvalidOperationException("The scene no longer exists.");
        original.WordCount = ScriptAwareCounting.Count(TextDiff.StripBlockHtml(beforeHtml));
        created.WordCount = ScriptAwareCounting.Count(TextDiff.StripBlockHtml(afterHtml));
        await staged.SaveScenesAsync();
        if (title is null) return Reference(staged, chapter.Guid, created.Id);
        var next = await staged.CreateChapterAsync(title.Trim(), insertAtOrder: chapter.Order + 1);
        next.Act = chapter.Act;
        var trailing = staged.GetScenesForChapter(chapter.Guid).OrderBy(scene => scene.Order).SkipWhile(scene => scene.Id != created.Id).Select(scene => scene.Id).ToArray();
        await MoveScenesAsync(staged, new(trailing, next.Guid, null));
        await staged.SaveProjectAsync();
        return Reference(staged, next.Guid, created.Id);
    }

    private static async Task MoveScenesAsync(ProjectService staged, MoveScenesCommand command)
    {
        var chapters = staged.GetChaptersOrdered();
        if (!chapters.Any(chapter => chapter.Guid == command.TargetChapterGuid)) throw new InvalidOperationException("Unknown destination chapter.");
        var ordered = chapters.SelectMany(chapter => staged.GetScenesForChapter(chapter.Guid).OrderBy(scene => scene.Order)).ToArray();
        RequireSelection(ordered.Select(scene => scene.Id), command.SceneIds);
        var remaining = staged.GetScenesForChapter(command.TargetChapterGuid).OrderBy(scene => scene.Order).Where(scene => !command.SceneIds.Contains(scene.Id)).Select(scene => scene.Id).ToArray();
        var destination = Destination(remaining, command.BeforeSceneId);
        var manifest = staged.ScenesManifest ?? throw new InvalidOperationException("No scene manifest loaded.");
        manifest.Chapters = chapters.ToDictionary(chapter => chapter.Guid, chapter => manifest.Chapters.GetValueOrDefault(chapter.Guid) ?? []);
        await staged.MoveScenesAsync(command.SceneIds, command.TargetChapterGuid, destination);
    }

    private static async Task MoveChaptersAsync(ProjectService staged, MoveChaptersCommand command)
    {
        var chapters = staged.GetChaptersOrdered();
        RequireSelection(chapters.Select(chapter => chapter.Guid), command.ChapterGuids);
        var act = RequireAct(staged, command.TargetActName);
        var remaining = chapters.Where(chapter => !command.ChapterGuids.Contains(chapter.Guid)).Select(chapter => chapter.Guid).ToArray();
        var destination = Destination(remaining, command.BeforeChapterGuid);
        foreach (var chapter in chapters.Where(chapter => command.ChapterGuids.Contains(chapter.Guid))) chapter.Act = act;
        await staged.MoveChaptersAsync(command.ChapterGuids, destination);
    }

    private static string RequireAct(ProjectService staged, string? name)
    {
        if (name is null) return string.Empty;
        return RequireBook(staged).Acts.Select(act => act.Name).Concat(RequireBook(staged).Chapters.Select(chapter => chapter.Act))
            .FirstOrDefault(act => !string.IsNullOrWhiteSpace(act) && act.Equals(name, StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException("act-not-found");
    }
    private static void RequireTitle(string title)
    {
        if (string.IsNullOrWhiteSpace(title)) throw new InvalidOperationException("A chapter title is required.");
    }
    private static int Destination(string[] remaining, string? before)
        => before is null ? remaining.Length : Array.IndexOf(remaining, before) is var index && index >= 0 ? index : throw new InvalidOperationException("Unknown structure destination.");
    private static void RequireSelection(IEnumerable<string> available, string[] selected)
    {
        if (selected.Length == 0 || selected.Distinct().Count() != selected.Length || selected.Except(available).Any()) throw new InvalidOperationException("Invalid structure selection.");
    }
    private static SceneRef Reference(ProjectService staged, string chapter, string scene)
        => new(RequireBook(staged).Id, RequireBook(staged).ActiveDraftId, chapter, scene);
    private static BookData RequireBook(ProjectService staged) => staged.ActiveBook ?? throw new InvalidOperationException("No book active.");
}
