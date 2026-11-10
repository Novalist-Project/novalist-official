using System.Text.Json;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Novalist.Core.Tests.TestHelpers;
using Xunit;

namespace Novalist.Core.Tests.Services;

public sealed class ManuscriptStructureDatesTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task InsertPayloadJournalsDatesWithItsEmptySceneAndActPlacement(bool includeDates)
    {
        using var directory = new TempDir();
        var projects = new ProjectService(new FileService());
        await projects.CreateProjectAsync(directory.Path, "Novel", "Book");
        var first = await projects.CreateChapterAsync("First");
        var second = await projects.CreateChapterAsync("Second");
        first.Act = "A";
        second.Act = "B";
        var book = Assert.IsType<BookData>(projects.ActiveBook);
        book.Acts = [new() { Name = "A" }, new() { Name = "B" }];
        await projects.SaveProjectAsync();
        var dateJson = includeDates
            ? """, "dateRange": { "start": "2026-03-01", "end": "2026-03-03", "note": "Journey", "startTime": "09:00", "endTime": "18:00" }"""
            : string.Empty;
        var command = JsonSerializer.Deserialize<StructureCommand>($$"""
            { "kind": "insertChapter", "title": "New chapter", "beforeChapterGuid": "{{second.Guid}}", "actName": "A"{{dateJson}} }
            """, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var service = new ManuscriptStructureService(projects);
        var request = new StructureRequest("dated-chapter", 0, book.Id, book.ActiveDraftId,
            Assert.IsType<InsertChapterCommand>(command));
        var result = await service.ExecuteAsync(request);
        var focus = Assert.IsType<SceneRef>(result.FocusScene);

        async Task AssertInsertedAsync()
        {
            var chapters = projects.GetChaptersOrdered();
            Assert.Equal([first.Guid, focus.ChapterGuid, second.Guid], chapters.Select(chapter => chapter.Guid));
            Assert.Equal(["A", "A", "B"], chapters.Select(chapter => chapter.Act));
            Assert.Empty(new ActStructureService(projects).Build(Assert.IsType<BookData>(projects.ActiveBook)).Issues);
            var created = chapters[1];
            if (includeDates)
            {
                var range = Assert.IsType<StoryDateRange>(created.DateRange);
                Assert.Equal("2026-03-01", range.Start);
                Assert.Equal("2026-03-03", range.End);
                Assert.Equal("Journey", range.Note);
                Assert.Equal("09:00", range.StartTime);
                Assert.Equal("18:00", range.EndTime);
                Assert.Equal(range.Start, created.Date);
            }
            else
            {
                Assert.Null(created.DateRange);
                Assert.Equal(string.Empty, created.Date);
            }
            var scene = Assert.Single(projects.GetScenesForChapter(created.Guid));
            Assert.Equal(focus.SceneId, scene.Id);
            Assert.Equal(string.Empty, await projects.ReadSceneContentAsync(created, scene));
        }

        await AssertInsertedAsync();
        Assert.Equal(focus, (await service.ExecuteAsync(request)).FocusScene);
        await service.RestoreAsync(result.OperationId, true);
        Assert.Equal([first.Guid, second.Guid], projects.GetChaptersOrdered().Select(chapter => chapter.Guid));
        Assert.Empty(projects.GetScenesForChapter(focus.ChapterGuid));
        Assert.Equal(focus, (await service.RestoreAsync(result.OperationId, false)).FocusScene);
        await AssertInsertedAsync();
    }
}
