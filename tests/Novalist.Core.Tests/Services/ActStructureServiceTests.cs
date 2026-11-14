using System.Text.Json;
using NSubstitute;
using Novalist.Core.Models;
using Novalist.Core.Services;
using Novalist.Core.Tests.TestHelpers;
using Xunit;

namespace Novalist.Core.Tests.Services;

public sealed class ActStructureServiceTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly ProjectService _projects = new(new FileService());
    public void Dispose() => _dir.Dispose();
    private async Task<ActStructureService> Open(params string[] assignments)
    {
        await _projects.CreateProjectAsync(_dir.Path, "Acts", "Book");
        _projects.ActiveBook!.Chapters = assignments.Select((act, i) => new ChapterData { Guid = $"c{i}", Order = i, Act = act }).ToList();
        return new ActStructureService(_projects);
    }

    [Fact]
    public async Task ProjectionPreservesUnassignedRunsAndPlacesEmptyActsBeforeNextPopulatedAct()
    {
        var sut = await Open("", "A", "a", "", "B", "");
        var book = _projects.ActiveBook!;
        book.Acts = [new() { Name = "Empty" }, new() { Name = "A" }, new() { Name = "B" }, new() { Name = "End" }];
        var result = sut.Build(book);
        Assert.Equal(new string?[] { null, "Empty", "A", null, "B", null, "End" }, result.Groups.Select(g => g.Name));
        Assert.Equal(new[] { "c1", "c2" }, result.Groups[2].ChapterGuids);
        Assert.Empty(result.Issues);
    }

    [Fact]
    public async Task LegacyInterleavingRequiresExplicitRevisionCheckedRegroup()
    {
        var sut = await Open("A", "", "B", "A");
        var book = _projects.ActiveBook!;
        var before = book.Chapters.Select(c => c.Guid).ToArray();
        Assert.Contains(sut.Build(book).Issues, i => i.Code == "interleaved-act");
        Assert.Equal(before, book.Chapters.OrderBy(c => c.Order).Select(c => c.Guid));
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.MoveAsync("A", null));
        var preview = sut.PreviewRegroup(book);
        Assert.Equal(before, preview.BeforeChapterGuids);
        Assert.Equal(new[] { "c0", "c3", "c1", "c2" }, preview.AfterChapterGuids);
        book.Chapters[0].Act = "X";
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.ApplyRegroupAsync(preview.RevisionToken));
        book.Chapters[0].Act = "A";
        await sut.ApplyRegroupAsync(preview.RevisionToken);
        Assert.Equal(preview.AfterChapterGuids, book.Chapters.OrderBy(c => c.Order).Select(c => c.Guid));
        Assert.Empty(sut.Build(book).Issues);
    }

    [Fact]
    public async Task WholeActMoveAndRemovalRetainChapterDataAndReversibleMetadata()
    {
        var sut = await Open("A", "A", "", "B");
        var book = _projects.ActiveBook!;
        book.Acts = [new() { Name = "A", WordTarget = 500, DateRange = new() { Start = "123" } }, new() { Name = "B" }];
        var moved = await sut.MoveAsync("A", null);
        Assert.Equal(new[] { "c2", "c3", "c0", "c1" }, book.Chapters.OrderBy(c => c.Order).Select(c => c.Guid));
        Assert.Equal(4, moved.AffectedChapterGuids.Length);
        var removed = await sut.RemoveAsync("a");
        Assert.All(book.Chapters, c => Assert.True(c.Act is "" or "B"));
        Assert.Contains("500", removed.Before.ActsJson);
        Assert.Contains("123", removed.Before.ActsJson);
        Assert.Equal(4, book.Chapters.Count);
    }

    [Fact]
    public async Task NamesAreUniqueAndRenameConflictsDoNotMutate()
    {
        var sut = await Open("A", "B");
        var book = _projects.ActiveBook!;
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.CreateAsync("a", null));
        Assert.False(sut.ValidateRename(book, "A", "b").IsValid);
        book.Premise.Acts["A"] = "source";
        book.Premise.Acts["Destination"] = "unrelated";
        Assert.False(sut.ValidateRename(book, "A", "Destination").IsValid);
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.RenameAsync("A", "Destination"));
        Assert.Equal("A", book.Chapters[0].Act);
    }

    [Fact]
    public async Task LegacyMobileDraftRoundTripKeepsExistingSchemaAndOrder()
    {
        const string json = "{\"chapters\":[{\"guid\":\"z\",\"order\":8,\"act\":\"Imported\"},{\"guid\":\"a\",\"order\":2,\"act\":\"\"}],\"acts\":[{\"name\":\"Empty\",\"wordTarget\":25,\"dateRange\":{\"start\":\"1\"}}]}";
        var data = JsonSerializer.Deserialize<BookDraftData>(json)!;
        var sut = await Open();
        var book = _projects.ActiveBook!;
        book.Chapters = data.Chapters;
        book.Acts = data.Acts;
        Assert.Equal(new[] { "a", "z" }, sut.Build(book).Groups.SelectMany(g => g.ChapterGuids));
        Assert.Equal(new[] { 8, 2 }, book.Chapters.Select(c => c.Order));
        var roundTrip = JsonSerializer.Deserialize<BookDraftData>(JsonSerializer.Serialize(data))!;
        Assert.Equal(25, roundTrip.Acts[0].WordTarget);
        Assert.Equal("1", roundTrip.Acts[0].DateRange!.Start);
        Assert.Equal("z", roundTrip.Chapters[0].Guid);
    }

    [Fact]
    public async Task CreateEmptyActsBeforeImplicitActsAndUndoRedo()
    {
        var sut = await Open("A", "B");
        var result = await sut.CreateAsync("Empty", "A");
        Assert.Equal(new[] { "Empty", "A", "B" }, _projects.ActiveBook!.Acts.Select(a => a.Name));
        Assert.Empty(result.AffectedChapterGuids);
        await sut.RestoreMutationAsync(result, true);
        Assert.Empty(_projects.ActiveBook.Acts);
        await sut.RestoreMutationAsync(result, false);
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.RestoreMutationAsync(result, false));
        await sut.MoveAsync("Empty", null);
        Assert.Equal(new[] { "A", "B", "Empty" }, _projects.ActiveBook.Acts.Select(a => a.Name));
        await sut.MoveAsync("A", "A");
        await sut.MoveAsync("B", "A");
        Assert.Equal(new[] { "c1", "c0" }, _projects.GetChaptersOrdered().Select(c => c.Guid));
    }

    [Fact]
    public async Task ValidationExplainsBlankDuplicateAndOutOfOrderMetadata()
    {
        var sut = await Open("A", "B");
        var book = _projects.ActiveBook!;
        Assert.Equal("invalid-act-name", sut.ValidateRename(book, "A", " ").ErrorCode);
        Assert.Equal("act-not-found", sut.ValidateRename(book, "missing", "C").ErrorCode);
        Assert.False((await sut.ValidateRenameAsync("missing", "C")).IsValid);
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.CreateAsync(" ", null));
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.CreateAsync("C", "missing"));
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.MoveAsync("missing", null));
        book.Acts = [new() { Name = "B" }, new() { Name = "A" }, new() { Name = "a" }, new() { Name = "" }];
        Assert.Equal(new[] { "blank-act-name", "duplicate-act-name", "act-order-mismatch" }.Order(), sut.Build(book).Issues.Select(i => i.Code).Order());
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.ApplyRegroupAsync(sut.PreviewRegroup(book).RevisionToken));
        book.Acts = [new() { Name = "B" }, new() { Name = "A" }];
        await sut.ApplyRegroupAsync(sut.PreviewRegroup(book).RevisionToken);
        Assert.Equal(new[] { "A", "B" }, book.Acts.Select(a => a.Name));
    }

    private async Task<EntityService> SeedReferences()
    {
        var entities = new EntityService(_projects);
        await entities.SaveCharacterAsync(new() { Id = "character", Name = "Person", ChapterOverrides = [new() { Act = "A", Age = "50" }, new() { Act = "A", Chapter = "other-draft", Age = "90" }], StateOverrides = [new() { Act = "A", Name = "Older" }] });
        await entities.SaveLocationAsync(new() { Id = "location", StateOverrides = [new() { Act = "A", Description = "Ruins" }] });
        await entities.SaveItemAsync(new() { Id = "item", StateOverrides = [new() { Act = "A", Name = "Broken" }] });
        await entities.SaveLoreAsync(new() { Id = "lore", StateOverrides = [new() { Act = "A", Gone = true }] });
        await entities.SaveCustomEntityTypeAsync(new() { TypeKey = "faction", FolderName = "Factions", DisplayName = "Faction" });
        await entities.SaveCustomEntityAsync(new() { Id = "faction", EntityTypeKey = "faction", StateOverrides = [new() { Act = "A", Note = "note" }] });
        await new VoiceCast(_projects, _projects.FileService).SetScopeAsync(null, new("A", null, null), "voice-id-with-old-scope-hash");
        _projects.ActiveBook!.Premise.Acts["A"] = "Original summary";
        _projects.ActiveBook.Acts = [new() { Name = "A", WordTarget = 100, DateRange = new() { Start = "1000", EndTime = "12:00" } }];
        return entities;
    }

    [Fact]
    public async Task RenameMovesAllReferencesAndSupportsMetadataUndoRedo()
    {
        var sut = await Open("A", "");
        var entities = await SeedReferences();
        Assert.True((await sut.ValidateRenameAsync("A", "C")).IsValid);
        var renamed = await sut.RenameAsync("A", "C");
        Assert.Equal("C", _projects.ActiveBook!.Chapters[0].Act);
        Assert.Equal(100, _projects.ActiveBook.Acts[0].WordTarget);
        Assert.Equal("12:00", _projects.ActiveBook.Acts[0].DateRange!.EndTime);
        Assert.Equal("Original summary", _projects.ActiveBook.Premise.Acts["C"]);
        Assert.False(_projects.ActiveBook.Premise.Acts.ContainsKey("A"));
        var character = (await entities.LoadCharactersAsync()).Single();
        Assert.Contains(character.ChapterOverrides, o => o.Act == "C" && o.Age == "50");
        Assert.Contains(character.ChapterOverrides, o => o.Act == "A" && o.Chapter == "other-draft");
        Assert.Equal("C", character.StateOverrides.Single().Act);
        Assert.Equal("C", (await new VoiceCast(_projects, _projects.FileService).ReadAsync()).Overrides.Single().Act);
        Assert.Equal(7, renamed.MetadataChanges.Length);
        await sut.RestoreMutationAsync(renamed, true);
        Assert.Equal("A", (await entities.LoadLocationsAsync()).Single().StateOverrides.Single().Act);
        await sut.RestoreMutationAsync(renamed, false);
        Assert.Equal("C", (await entities.LoadItemsAsync()).Single().StateOverrides.Single().Act);
        var caseChanged = await sut.RenameAsync("C", "c");
        Assert.Equal("c", _projects.ActiveBook.Chapters[0].Act);
        Assert.NotEmpty(caseChanged.MetadataChanges);
    }

    [Fact]
    public async Task RenameCopiesSharedReferencesWhenOtherDraftRetainsOldAct()
    {
        var sut = await Open("A");
        var entities = await SeedReferences();
        var original = _projects.ActiveBook!.ActiveDraftId;
        var clone = await _projects.CreateDraftAsync("Clone", original);
        var renamed = await sut.RenameAsync("A", "New");
        Assert.Equal(2, _projects.ActiveBook.Premise.Acts.Count);
        var states = (await entities.LoadCharactersAsync()).Single().StateOverrides;
        Assert.Equal(new[] { "A", "New" }, states.Select(o => o.Act));
        Assert.Equal(2, states.Select(o => o.Id).Distinct().Count());
        Assert.Equal(2, (await new VoiceCast(_projects, _projects.FileService).ReadAsync()).Overrides.Count);
        await _projects.SwitchDraftAsync(clone.Id);
        Assert.Equal("A", _projects.ActiveBook.Chapters.Single().Act);
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.RestoreMutationAsync(renamed, true));
    }

    [Fact]
    public async Task DestinationReferencesArePreflightedBeforeAnyWrites()
    {
        var sut = await Open("A");
        var entities = await SeedReferences();
        var character = (await entities.LoadCharactersAsync()).Single();
        character.ChapterOverrides.Add(new() { Act = "New", Age = "Unrelated" });
        await entities.SaveCharacterAsync(character);
        var invalid = await sut.ValidateRenameAsync("A", "New");
        Assert.False(invalid.IsValid);
        Assert.Contains("character/character/chapterOverrides", invalid.ConflictingReferenceScopes);
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.RenameAsync("A", "New"));
        Assert.Equal("A", _projects.ActiveBook!.Chapters.Single().Act);
        Assert.Equal("A", (await entities.LoadItemsAsync()).Single().StateOverrides.Single().Act);
    }

    [Fact]
    public async Task CancelledAndMissingContextsNeverMutate()
    {
        var sut = await Open("A");
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => sut.CreateAsync("New", null, cancelled.Token));
        Assert.Empty(_projects.ActiveBook!.Acts);
        _projects.CloseProject();
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.RemoveAsync("A"));
    }

    [Fact]
    public async Task PersistenceFailureRestoresAllTouchedMetadataAndStructure()
    {
        await Open("A");
        var entities = await SeedReferences();
        var proxy = Substitute.For<IProjectService>();
        proxy.ActiveBook.Returns(_projects.ActiveBook);
        proxy.ProjectRoot.Returns(_projects.ProjectRoot);
        proxy.CurrentProject.Returns(_projects.CurrentProject);
        proxy.BookRootFor(Arg.Any<BookData>()).Returns(_projects.ActiveBookRoot);
        var attempt = 0;
        proxy.SaveProjectAsync().Returns(_ => ++attempt == 1 ? Task.FromException(new IOException("injected write failure")) : Task.CompletedTask);
        var sut = new ActStructureService(proxy, entities, _projects.FileService);
        await Assert.ThrowsAsync<IOException>(() => sut.RenameAsync("A", "New"));
        Assert.Equal("A", _projects.ActiveBook!.Chapters.Single().Act);
        Assert.Equal("A", (await entities.LoadCharactersAsync()).Single().StateOverrides.Single().Act);
        Assert.Equal("A", (await new VoiceCast(_projects, _projects.FileService).ReadAsync()).Overrides.Single().Act);
        Assert.Equal(2, attempt);
    }

    [Fact]
    public async Task OtherBooksRetainSharedNarrationButTheirAssignmentsStayUntouched()
    {
        var sut = await Open("A");
        await SeedReferences();
        var other = await _projects.CreateBookAsync("Other");
        other.Acts = [new() { Name = "A" }];
        var renamed = await sut.RenameAsync("A", "New");
        Assert.Equal("A", other.Acts.Single().Name);
        Assert.Equal(2, (await new VoiceCast(_projects, _projects.FileService).ReadAsync()).Overrides.Count);
        Assert.NotEqual(renamed.Before.RevisionToken, renamed.After.RevisionToken);
    }

    [Fact]
    public async Task EmptyOtherDraftDoesNotRetainUnusedReferences()
    {
        var sut = await Open("A");
        await SeedReferences();
        await _projects.CreateDraftAsync("Empty");
        await sut.RenameAsync("A", "New");
        Assert.Single(_projects.ActiveBook!.Premise.Acts);
        Assert.Equal("New", (await new VoiceCast(_projects, _projects.FileService).ReadAsync()).Overrides.Single().Act);
    }

    [Fact]
    public async Task UndoRefusesEditedOrMissingReferencesAndInvalidSnapshots()
    {
        var sut = await Open("A");
        var entities = await SeedReferences();
        var renamed = await sut.RenameAsync("A", "New");
        var missing = renamed with { MetadataChanges = [new("untrusted/path", "[]", "[]")] };
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.RestoreMutationAsync(missing, true));
        var invalid = renamed with { MetadataChanges = [renamed.MetadataChanges[0] with { BeforeJson = "null" }] };
        await Assert.ThrowsAsync<InvalidDataException>(() => sut.RestoreMutationAsync(invalid, true));
        var invalidChapter = renamed with { Before = renamed.Before with { Chapters = [] } };
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.RestoreMutationAsync(invalidChapter, true));
        var character = (await entities.LoadCharactersAsync()).Single();
        character.StateOverrides[0].Name = "Edited after rename";
        await entities.SaveCharacterAsync(character);
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.RestoreMutationAsync(renamed, true));
        Assert.Equal("New", _projects.ActiveBook!.Chapters.Single().Act);
    }

    [Fact]
    public async Task DelayedPreflightRejectsChangedDraftOwnership()
    {
        await Open("A");
        var entities = Substitute.For<IEntityService>();
        var blocked = new TaskCompletionSource<List<CharacterData>>();
        entities.LoadCharactersAsync().Returns(blocked.Task);
        entities.LoadLocationsAsync().Returns(new List<LocationData>());
        entities.LoadItemsAsync().Returns(new List<ItemData>());
        entities.LoadLoreAsync().Returns(new List<LoreData>());
        entities.GetCustomEntityTypes().Returns(new List<CustomEntityTypeDefinition>());
        var sut = new ActStructureService(_projects, entities);
        var pending = sut.ValidateRenameAsync("A", "New");
        _projects.ActiveBook!.ActiveDraftId = "different-draft";
        blocked.SetResult([]);
        await Assert.ThrowsAsync<InvalidOperationException>(() => pending);
        Assert.Equal("A", _projects.ActiveBook.Chapters.Single().Act);
        var proxy = Substitute.For<IProjectService>();
        Assert.Throws<ArgumentException>(() => new ActStructureService(proxy));
        Assert.Throws<ArgumentException>(() => new ActStructureService(proxy, files: _projects.FileService));
    }

    [Fact]
    public async Task DuplicateConflictingSourceScopesAreRejectedRatherThanCollapsed()
    {
        var sut = await Open("A");
        var entities = await SeedReferences();
        var character = (await entities.LoadCharactersAsync()).Single();
        character.StateOverrides.Add(new() { Act = "A", Name = "Conflicting duplicate" });
        await entities.SaveCharacterAsync(character);
        Assert.False((await sut.ValidateRenameAsync("A", "New")).IsValid);
        _projects.ActiveBook!.Premise.Acts["a"] = "Conflicting summary";
        Assert.False(sut.ValidateRename(_projects.ActiveBook, "A", "New").IsValid);
    }

    [Fact]
    public async Task IdenticalDestinationScopesAreReusedWithoutDuplicatingReferences()
    {
        var sut = await Open("A");
        var entities = await SeedReferences();
        var character = (await entities.LoadCharactersAsync()).Single();
        character.StateOverrides.Add(new() { Act = "New", Name = "Older" });
        await entities.SaveCharacterAsync(character);
        await sut.RenameAsync("A", "New");
        Assert.Single((await entities.LoadCharactersAsync()).Single().StateOverrides);
    }

    [Fact]
    public async Task OpeningPersistedInterleavedLegacyDataNeverRegroupsIt()
    {
        await Open("A", "B", "A");
        var chapters = _projects.ActiveBook!.Chapters;
        for (var index = 0; index < chapters.Count; index++) chapters[index].FolderName = $"chapter-{index}";
        _projects.ActiveBook.Acts = [new() { Name = "A", DateRange = new() { Start = "old-date" }, WordTarget = 800 }, new() { Name = "B" }];
        await _projects.SaveProjectAsync();
        var beforeOrder = _projects.GetChaptersOrdered().Select(c => c.Guid).ToArray();
        var loaded = new ProjectService(new FileService());
        await loaded.LoadProjectAsync(_projects.ProjectRoot!);
        Assert.Equal(beforeOrder, loaded.GetChaptersOrdered().Select(c => c.Guid));
        var structure = new ActStructureService(loaded).Build(loaded.ActiveBook!);
        Assert.Contains(structure.Issues, issue => issue.Code == "interleaved-act");
        var projected = structure.Groups.First(g => g.Name == "A").Metadata!;
        Assert.Equal(800, projected.WordTarget);
        projected.DateRange!.Start = "projection-only";
        Assert.Equal("old-date", loaded.ActiveBook!.Acts[0].DateRange!.Start);
    }
}
