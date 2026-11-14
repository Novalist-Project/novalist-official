using System.Text.Json;
using Novalist.Core.Models;
using Novalist.Core.Utilities;

namespace Novalist.Core.Services;

public partial class ProjectService
{
    public async Task<WritingMutationPlan> PlanWritingAsync(WritingCommitRequest request, CancellationToken ct = default)
    {
        if (request.Changes.Length + request.AnnotationChanges.Length == 0
            || request.Changes.Select(change => change.Ref).Distinct().Count() != request.Changes.Length
            || request.AnnotationChanges.Select(change => change.Ref).Distinct().Count() != request.AnnotationChanges.Length
            || request.Changes.Any(change => change.ExpectedRevision < 0))
            throw new InvalidDataException("Invalid writing changes.");
        var reader = new SceneDocumentReader(this, _fileService);
        var resolved = new List<ResolvedWritingScene>();
        foreach (var reference in request.Changes.Select(change => change.Ref).Concat(request.AnnotationChanges.Select(change => change.Ref)).Distinct())
            resolved.Add(await reader.ResolveAsync(reference, ct));
        var plans = new List<WritingMutationPlan>();
        foreach (var group in resolved.GroupBy(scene => scene.DraftRoot))
            plans.Add(await PlanWritingDraftAsync(request, group.ToArray(), ct));
        return new(plans.SelectMany(plan => plan.Files).ToArray(), plans.SelectMany(plan => plan.Hashes).ToArray(),
            plans.SelectMany(plan => plan.Conflicts).ToArray(), plans.SelectMany(plan => plan.WordCounts).ToArray());
    }

    private async Task<WritingMutationPlan> PlanWritingDraftAsync(WritingCommitRequest request, ResolvedWritingScene[] scenes, CancellationToken ct)
    {
        var files = new List<WritingFileMutation>();
        var conflicts = new List<WritingSceneHash>();
        var hashes = new List<WritingSceneHash>();
        var words = new List<WritingWordCount>();
        var path = Path.Combine(scenes[0].DraftRoot, "scenes.json");
        var before = await _fileService.ReadTextAsync(path);
        var manifest = JsonSerializer.Deserialize<ScenesManifest>(before, JsonOptions)
            ?? throw new InvalidDataException("Invalid scene manifest.");
        foreach (var resolved in scenes)
        {
            ct.ThrowIfCancellationRequested();
            var scene = manifest.Chapters.GetValueOrDefault(resolved.Ref.ChapterGuid)?.SingleOrDefault(scene => scene.Id == resolved.Ref.SceneId)
                ?? throw new InvalidDataException("The writing scene changed outside Novalist.");
            var raw = await _fileService.ExistsAsync(resolved.Path) ? await _fileService.ReadTextAsync(resolved.Path) : null;
            if (raw is not null && FileFrontMatter.TryParse(raw, out var identity) && identity.Id != scene.Id)
                throw new IOException("The writing scene identity changed outside Novalist.");
            var html = FileFrontMatter.Strip(raw ?? string.Empty);
            var hash = ContentHasher.Hash(html);
            var prose = request.Changes.SingleOrDefault(change => change.Ref == resolved.Ref);
            var annotations = request.AnnotationChanges.SingleOrDefault(change => change.Ref == resolved.Ref);
            if (WritingConflict(prose, annotations, scene, hash))
            {
                conflicts.Add(new(resolved.Ref, hash));
                continue;
            }
            if (prose is not null)
            {
                files.Add(new(resolved.Path, raw, FileFrontMatter.Stamp(FileFrontMatter.Strip(prose.AfterHtml), scene.Id)));
                scene.WordCount = ScriptAwareCounting.Count(TextDiff.StripBlockHtml(prose.AfterHtml));
                words.Add(new(resolved.Ref.BookId, scene.Id, scene.WordCount));
            }
            if (annotations is not null) ApplyWritingAnnotations(scene, annotations.After);
            hashes.Add(new(resolved.Ref, prose is null ? hash : ContentHasher.Hash(prose.AfterHtml)));
        }
        files.Add(new(path, before, JsonSerializer.Serialize(manifest, JsonOptions)));
        return new(files.ToArray(), hashes.ToArray(), conflicts.ToArray(), words.ToArray());
    }

    private static bool WritingConflict(Models.SceneChange? prose, AnnotationChange? annotations, SceneData scene, string hash)
        => (prose is not null && (ContentHasher.Hash(prose.BeforeHtml) != hash
            || (prose.ExpectedHash is not null && prose.ExpectedHash != hash)))
            || (annotations is not null && !SameWritingAnnotations(annotations.Before, WritingAnnotations.FromScene(scene)));

    private static bool SameWritingAnnotations(WritingAnnotations left, WritingAnnotations right)
        => left.Comments.Length == right.Comments.Length
            && left.Comments.Zip(right.Comments).All(pair => pair.First.Matches(pair.Second))
            && left.Footnotes.SequenceEqual(right.Footnotes);

    private void ApplyWritingAnnotations(SceneData scene, WritingAnnotations annotations)
    {
        if (annotations.Comments.Select(comment => comment.Id).Distinct().Count() != annotations.Comments.Length
            || annotations.Footnotes.Select(note => note.Id).Distinct().Count() != annotations.Footnotes.Length
            || annotations.Comments.Any(comment => comment.Replies is { } replies && replies.Select(reply => reply.Id).Distinct().Count() != replies.Length))
            throw new InvalidDataException("Duplicate writing annotation identity.");
        var previous = (scene.Comments ?? []).ToDictionary(comment => comment.Id);
        scene.Comments = annotations.Comments.Select(comment =>
        {
            var kept = previous.GetValueOrDefault(comment.Id) ?? new SceneComment { Id = comment.Id, Author = ProjectSettings.Author };
            comment.ApplyTo(kept);
            return kept;
        }).ToList();
        scene.Footnotes = annotations.Footnotes.Select(note => new SceneFootnote { Id = note.Id, Number = note.Number, Text = note.Text }).ToList();
    }
}

public sealed record WritingWordCount(string BookId, string SceneId, int Words);
public sealed record WritingMutationPlan(WritingFileMutation[] Files, WritingSceneHash[] Hashes,
    WritingSceneHash[] Conflicts, WritingWordCount[] WordCounts);
