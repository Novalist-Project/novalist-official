using System.Text.Json;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Xunit;
using SceneChange = Novalist.Core.Models.SceneChange;

namespace Novalist.Core.Tests.Services;

public sealed class WritingMutationPlanningTests
{
    [Fact]
    public async Task PlansProseAnnotationsAndWordCountsWithoutChangingStoredOrLoadedScenes()
    {
        using var fixture = new WritingServiceFixture();
        var reference = await fixture.CreateAsync();
        var document = await fixture.Reader.ResolveAsync(reference);
        document.Scene.Comments = [new() { Id = "existing", Text = "Original", Author = "Writer" }];
        await fixture.Projects.SaveScenesAsync();
        var original = await fixture.Files.ReadTextAsync(document.Path);
        var before = WritingAnnotations.FromScene(document.Scene);
        var after = new WritingAnnotations(
            [new("existing", "anchor", "Revised", true), new("new", "", "New note", false)],
            [new("footnote", 1, "Footnote text")]);
        var request = new WritingCommitRequest("operation", 0,
            [new(reference, 2, "Before", "<h1>One</h1><p>two three</p>", ContentHasher.Hash("Before"))],
            [new(reference, before, after)]);

        var plan = await fixture.Projects.PlanWritingAsync(request);

        Assert.Empty(plan.Conflicts);
        Assert.Equal(3, Assert.Single(plan.WordCounts).Words);
        Assert.Equal(ContentHasher.Hash(request.Changes[0].AfterHtml), Assert.Single(plan.Hashes).Hash);
        Assert.Equal(original, await fixture.Files.ReadTextAsync(document.Path));
        Assert.Equal("Original", Assert.Single(document.Scene.Comments).Text);
        var prose = Assert.Single(plan.Files, file => file.Path == document.Path);
        Assert.Equal(request.Changes[0].AfterHtml, FileFrontMatter.Strip(prose.After!));
        var manifest = JsonSerializer.Deserialize<ScenesManifest>(Assert.Single(plan.Files, file => file.Path.EndsWith("scenes.json")).After!);
        var planned = Assert.Single(manifest!.Chapters[reference.ChapterGuid]);
        Assert.Equal("Writer", planned.Comments![0].Author);
        Assert.Equal("Revised", planned.Comments[0].Text);
        Assert.Equal("New note", planned.Comments[1].Text);
        Assert.Equal("Footnote text", Assert.Single(planned.Footnotes!).Text);
    }

    [Fact]
    public async Task ReportsProseAndAnnotationConflictsBeforePreparingSceneWrites()
    {
        using var fixture = new WritingServiceFixture();
        var reference = await fixture.CreateAsync();
        var request = new WritingCommitRequest("operation", 0, [new(reference, 0, "Before", "After", "stale")], []);
        var plan = await fixture.Projects.PlanWritingAsync(request);
        Assert.Equal(reference, Assert.Single(plan.Conflicts).Ref);
        Assert.Empty(plan.Hashes);
        Assert.Empty(plan.WordCounts);
        Assert.Single(plan.Files);

        var stale = new WritingAnnotations([new("missing", "", "Old", false)], []);
        plan = await fixture.Projects.PlanWritingAsync(request with
        {
            Changes = [], AnnotationChanges = [new(reference, stale, new([], []))]
        });
        Assert.Single(plan.Conflicts);
        Assert.Empty(plan.Hashes);

        plan = await fixture.Projects.PlanWritingAsync(request with
        {
            Changes = [], AnnotationChanges = [new(reference, new([], []), new([], [new("note", 1, "Text")]))]
        });
        Assert.Empty(plan.WordCounts);
        Assert.Equal(ContentHasher.Hash("Before"), Assert.Single(plan.Hashes).Hash);
    }

    [Fact]
    public async Task RejectsInvalidBatchesAndDuplicateAnnotationIdentities()
    {
        using var fixture = new WritingServiceFixture();
        var reference = await fixture.CreateAsync();
        var change = new SceneChange(reference, 0, "Before", "After");
        var annotation = new AnnotationChange(reference, new([], []), new([], []));
        var request = new WritingCommitRequest("operation", 0, [], []);
        await Assert.ThrowsAsync<InvalidDataException>(() => fixture.Projects.PlanWritingAsync(request));
        await Assert.ThrowsAsync<InvalidDataException>(() => fixture.Projects.PlanWritingAsync(request with { Changes = [change, change] }));
        await Assert.ThrowsAsync<InvalidDataException>(() => fixture.Projects.PlanWritingAsync(request with { AnnotationChanges = [annotation, annotation] }));
        await Assert.ThrowsAsync<InvalidDataException>(() => fixture.Projects.PlanWritingAsync(request with { Changes = [change with { ExpectedRevision = -1 }] }));
        var duplicateComments = new WritingAnnotations([new("same", "", "", false), new("same", "", "", false)], []);
        var duplicateNotes = new WritingAnnotations([], [new("same", 1, ""), new("same", 2, "")]);
        var duplicateReplies = new WritingAnnotations([new("comment", "", "", false) { Replies =
            [new("same", "", "", DateTime.UtcNow), new("same", "", "", DateTime.UtcNow)] }], []);
        foreach (var after in new[] { duplicateComments, duplicateNotes, duplicateReplies })
            await Assert.ThrowsAsync<InvalidDataException>(() => fixture.Projects.PlanWritingAsync(request with
            {
                AnnotationChanges = [annotation with { After = after }]
            }));
    }

    [Fact]
    public async Task PlansMissingSceneFilesAndRejectsChangedFileIdentity()
    {
        using var fixture = new WritingServiceFixture();
        var reference = await fixture.CreateAsync();
        var document = await fixture.Reader.ResolveAsync(reference);
        File.Delete(document.Path);
        var request = new WritingCommitRequest("operation", 0, [new(reference, 0, "", "Restored")], []);
        var plan = await fixture.Projects.PlanWritingAsync(request);
        Assert.Null(Assert.Single(plan.Files, file => file.Path == document.Path).Before);
        Assert.Empty(plan.Conflicts);
        await fixture.Files.WriteTextAsync(document.Path, FileFrontMatter.Stamp("Before", "different-scene"));
        await Assert.ThrowsAsync<IOException>(() => fixture.Projects.PlanWritingAsync(request));
    }

    [Fact]
    public async Task WordHistoryPlanningKeepsStoredBaselineUntilItsMutationIsCommitted()
    {
        using var fixture = new WritingServiceFixture();
        var reference = await fixture.CreateAsync();
        var history = new WordHistoryService(fixture.Files, fixture.Projects);
        var empty = await history.PlanWritingSavesAsync([new(reference.BookId, reference.SceneId, 3)]);
        Assert.Null(empty.Before);
        Assert.False(File.Exists(empty.Path));
        await history.RecordBaselineAsync(reference.BookId, reference.SceneId, 1);
        history.Reset();
        var plan = await history.PlanWritingSavesAsync([new(reference.BookId, reference.SceneId, 3)]);
        Assert.Equal(plan.Before, await fixture.Files.ReadTextAsync(plan.Path));
        var row = JsonSerializer.Deserialize<WordHistoryEntry>(plan.After!.Split('\n', StringSplitOptions.RemoveEmptyEntries).Last());
        Assert.Equal(3, row!.Words);
        Assert.Equal(2, row.Delta);
        fixture.Projects.CloseProject();
        await Assert.ThrowsAsync<InvalidOperationException>(() => history.PlanWritingSavesAsync([]));
    }
}
