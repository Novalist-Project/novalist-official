using Novalist.Core.Models;
using Novalist.Core.Services;
using Xunit;

namespace Novalist.Core.Tests.Services;

public sealed class WritingDocumentServiceTests
{
    [Fact]
    public async Task CatalogAndPassiveReadsIncludeOtherBooksWithoutChangingActiveContext()
    {
        using var fixture = new WritingServiceFixture();
        var first = await fixture.CreateAsync();
        var other = await fixture.Projects.CreateBookAsync("Second");
        await fixture.Projects.SwitchBookAsync(other.Id);
        var second = await fixture.AddSceneAsync("Other", "Offscreen prose");
        var catalog = new WritingSearchCatalog(fixture.Projects, fixture.Files);

        var targets = await catalog.ReadAsync(second.BookId, second.DraftId, true, default);
        Assert.Equal(new[] { first, second }, targets.Select(target => target.Ref));
        Assert.Equal(second, Assert.Single(await catalog.ReadAsync(second.BookId, second.DraftId, false, default)).Ref);
        var snapshot = await fixture.Reader.ReadAsync(first);
        Assert.Equal("Before", snapshot.Html);
        Assert.Equal(ContentHasher.Hash(snapshot.Html), snapshot.Hash);
        Assert.Equal(other.Id, fixture.Projects.ActiveBook!.Id);
        var document = await fixture.Reader.ResolveAsync(first);
        var archived = await new SnapshotService(fixture.Projects, fixture.Files)
            .TakeWritingContentAsync(document, "Before replacement", "<p>Two words</p>");
        Assert.Equal(2, archived.WordCount);
        Assert.Equal("<p>Two words</p>", archived.Content);
        Assert.Single(Directory.GetFiles(Path.Combine(document.DraftRoot, document.Book.SnapshotFolder, first.SceneId)));
        Assert.Equal(other.Id, fixture.Projects.ActiveBook.Id);
    }

    [Fact]
    public async Task PassiveReadsRejectUnknownReferencesCancellationAndMismatchedFileIdentity()
    {
        using var fixture = new WritingServiceFixture();
        var reference = await fixture.CreateAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Reader.ReadAsync(reference with { BookId = "missing" }));
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Reader.ReadAsync(reference with { DraftId = "missing" }));
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Reader.ReadAsync(reference with { ChapterGuid = "missing" }));
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Reader.ReadAsync(reference with { SceneId = "missing" }));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Reader.ReadAsync(reference, new(true)));
        var document = await fixture.Reader.ResolveAsync(reference);
        File.Delete(document.Path);
        Assert.Equal("", (await fixture.Reader.ReadAsync(reference)).Html);
        await fixture.Files.WriteTextAsync(document.Path, FileFrontMatter.Stamp("Foreign", "different"));
        await Assert.ThrowsAsync<IOException>(() => fixture.Reader.ReadAsync(reference));
        fixture.Projects.CloseProject();
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.Reader.ReadAsync(reference));
        await Assert.ThrowsAsync<InvalidOperationException>(() => new WritingSearchCatalog(fixture.Projects, fixture.Files)
            .ReadAsync(reference.BookId, reference.DraftId, true, default));
    }

    [Fact]
    public async Task SearchExtrasRetainExplicitReferencesAndNotesReplacementLeavesProseAndCommentsAlone()
    {
        using var fixture = new WritingServiceFixture();
        var reference = await fixture.CreateAsync();
        var document = await fixture.Reader.ResolveAsync(reference);
        document.Scene.Synopsis = "wolf synopsis";
        document.Scene.Notes = "wolf note";
        document.Scene.Comments = [new() { Id = "comment", Text = "wolf conversation" }];
        await fixture.Projects.SaveScenesAsync();
        var entities = new EntityService(fixture.Projects);
        await entities.SaveCharacterAsync(new() { Id = "person", Name = "Wolf" });
        var search = new FindReplaceService(fixture.Projects, entities);
        var options = new FindOptions { Pattern = "wolf", IncludeSceneNotes = true, IncludeCodex = true, Replacement = "fox" };

        Assert.Empty(await search.FindWritingExtrasAsync(new(), [document]));
        var matches = await search.FindWritingExtrasAsync(options, [document]);
        Assert.Equal(new[] { "synopsis", "notes", "comment", "codex" }, matches.Select(match => match.Field));
        Assert.All(matches.Take(3), match => Assert.Equal(reference, match.Ref));
        Assert.Equal("", matches[^1].Ref.DraftId);
        Assert.Single(await search.FindWritingExtrasAsync(new() { Pattern = "wolf", IncludeCodex = true }, [document]));
        var hidden = await fixture.AddSceneAsync("Hidden", "wolf prose");
        var hiddenDocument = await fixture.Reader.ResolveAsync(hidden);
        hiddenDocument.Scene.Notes = "wolf hidden";
        await fixture.Projects.SaveScenesAsync();

        var count = await search.ReplaceNotesAsync(options, [reference], new SnapshotService(fixture.Projects, fixture.Files), default);

        Assert.Equal(2, count);
        Assert.Equal("fox synopsis", document.Scene.Synopsis);
        Assert.Equal("fox note", document.Scene.Notes);
        Assert.Equal("wolf conversation", Assert.Single(document.Scene.Comments).Text);
        Assert.Equal("wolf hidden", hiddenDocument.Scene.Notes);
        Assert.Equal("Before", (await fixture.Reader.ReadAsync(reference)).Html);
        Assert.NotEmpty(await new SnapshotService(fixture.Projects, fixture.Files).ListAsync(document.Scene));
    }
}
