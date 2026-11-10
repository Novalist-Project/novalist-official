using Novalist.Core.Models;

namespace Novalist.Core.Services;

public static class WritingAnnotationMerge
{
    public static WritingAnnotations? Merge(WritingAnnotations before, WritingAnnotations after, WritingAnnotations current)
    {
        var comments = MergeRecords(before.Comments, after.Comments, current.Comments, comment => comment.Id,
            (left, right) => left.Matches(right), (desired, actual) =>
            {
                var stored = new SceneComment { Id = desired.Id };
                actual?.ApplyTo(stored);
                desired.ApplyTo(stored);
                return WritingComment.FromScene(stored);
            });
        var footnotes = MergeRecords(before.Footnotes, after.Footnotes, current.Footnotes, note => note.Id,
            (left, right) => left == right, (desired, _) => desired);
        return comments is null || footnotes is null ? null : new(comments, footnotes);
    }

    private static T[]? MergeRecords<T>(T[] before, T[] after, T[] current, Func<T, string> identity,
        Func<T, T, bool> same, Func<T, T?, T> apply) where T : class
    {
        foreach (var records in new[] { before, after, current })
            if (records.Any(record => string.IsNullOrWhiteSpace(identity(record))) || records.Select(identity).Distinct().Count() != records.Length)
                throw new InvalidDataException("Duplicate or missing writing annotation identity.");
        var original = before.ToDictionary(identity);
        var desired = after.ToDictionary(identity);
        var actual = current.ToDictionary(identity);
        foreach (var id in original.Keys.Union(desired.Keys))
        {
            var old = original.GetValueOrDefault(id);
            var next = desired.GetValueOrDefault(id);
            if (old is not null && next is not null && same(next, old)) continue;
            var present = actual.GetValueOrDefault(id);
            if (old is null ? present is not null : present is null || !same(old, present)) return null;
            if (next is null) actual.Remove(id);
            else actual[id] = apply(next, present);
        }
        return actual.Values.ToArray();
    }
}
