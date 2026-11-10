using System.Text.RegularExpressions;
using Novalist.Core.Models;
using Novalist.Core.Utilities;
using WritingSceneChange = Novalist.Core.Models.SceneChange;

namespace Novalist.Core.Services;

public sealed partial class FindReplaceService
{
    public async Task<WritingMatch[]> FindWritingExtrasAsync(FindOptions options, IReadOnlyList<ResolvedWritingScene> scenes)
    {
        if (string.IsNullOrEmpty(options.Pattern)) return [];
        var regex = BuildRegex(options);
        var results = new List<FindMatch>();
        if (options.IncludeSceneNotes) foreach (var document in scenes)
        {
            var source = new SceneSearchSource(document.Book.Id, document.Book.Name, document.Chapter, document.Scene);
            Collect(results, regex, document.Scene.Synopsis ?? string.Empty, "synopsis", source);
            Collect(results, regex, document.Scene.Notes ?? string.Empty, "notes", source);
            foreach (var comment in document.Scene.Comments ?? []) Collect(results, regex, comment.Text ?? string.Empty, "comment", source);
        }
        if (options.IncludeCodex) await CollectCodexAsync(results, regex);
        return results.Select(match => new WritingMatch(
            scenes.FirstOrDefault(scene => scene.Ref.BookId == match.BookId && scene.Ref.SceneId == match.SceneId)?.Ref
                ?? new SceneRef(match.BookId, string.Empty, match.ChapterGuid, match.SceneId),
            match.Field, match.Index, match.Length, string.Empty, 0, match.Before, match.MatchedText, match.After)).ToArray();
    }

    public static WritingMatch[] FindWriting(FindOptions options, IReadOnlyList<WritingSceneSnapshot> snapshots)
    {
        if (string.IsNullOrEmpty(options.Pattern)) return [];
        var regex = BuildRegex(options);
        return snapshots.SelectMany(snapshot =>
        {
            var text = new HtmlSearchText(snapshot.Html).Text;
            return regex.Matches(text).Cast<Match>().Select(match => new WritingMatch(snapshot.Ref,
                "prose", match.Index, match.Length, snapshot.Hash, snapshot.Revision,
                SnippetBefore(text, match.Index), match.Value, SnippetAfter(text, match.Index + match.Length)));
        }).ToArray();
    }

    public static WritingSceneChange[] PrepareWritingReplace(FindOptions options, IReadOnlyList<WritingSceneSnapshot> snapshots,
        IReadOnlyList<WritingMatch> matches, string replacement)
    {
        var available = FindWriting(options, snapshots).ToHashSet();
        if (matches.Distinct().Count() != matches.Count || matches.Any(match => !available.Contains(match)))
            throw new InvalidOperationException("The search results changed. Search again before replacing.");
        var regex = BuildRegex(options);
        var documents = snapshots.ToDictionary(snapshot => snapshot.Ref);
        return matches.GroupBy(match => match.Ref).Select(group =>
        {
            var snapshot = documents[group.Key];
            var text = new HtmlSearchText(snapshot.Html);
            var selected = group.Select(match => (match.Index, match.Length)).ToHashSet();
            var occurrences = regex.Matches(text.Text).Cast<Match>()
                .Where(match => selected.Contains((match.Index, match.Length))).ToArray();
            return new WritingSceneChange(snapshot.Ref, snapshot.Revision, snapshot.Html,
                text.Replace(occurrences, replacement).Html, snapshot.Hash);
        }).ToArray();
    }
}
