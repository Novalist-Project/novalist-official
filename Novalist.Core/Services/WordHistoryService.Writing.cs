using System.Text;
using System.Text.Json;
using Novalist.Core.Models;

namespace Novalist.Core.Services;

public sealed partial class WordHistoryService
{
    public async Task<WritingFileMutation> PlanWritingSavesAsync(IEnumerable<WritingWordCount> counts)
    {
        var path = HistoryFilePath ?? throw new InvalidOperationException("No project open.");
        await _gate.WaitAsync();
        try
        {
            if (!_loaded) await LoadInternalNoLockAsync();
            var before = await _fileService.ExistsAsync(path) ? await _fileService.ReadTextAsync(path) : null;
            var content = new StringBuilder(before);
            var today = DateOnly.FromDateTime(DateTime.Now).ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            foreach (var count in counts)
                content.AppendLine(JsonSerializer.Serialize(new WordHistoryEntry
                {
                    Date = today, BookId = count.BookId, SceneId = count.SceneId,
                    Words = count.Words, Delta = count.Words - _lastWordsPerScene.GetValueOrDefault(count.SceneId)
                }));
            return new(path, before, content.ToString());
        }
        finally { _gate.Release(); }
    }
}
