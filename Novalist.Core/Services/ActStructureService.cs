using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Novalist.Core.Models;

namespace Novalist.Core.Services;

// Callers hold the project mutation gate across operations and draft switches.
public sealed class ActStructureService
{
    private readonly IProjectService _projects;
    private readonly IEntityService _entities;
    private readonly IFileService _files;
    private static readonly JsonSerializerOptions CastOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static bool Same(string? left, string? right) => string.Equals(left, right, StringComparison.OrdinalIgnoreCase);

    public ActStructureService(IProjectService projects, IEntityService? entities = null, IFileService? files = null)
    {
        _projects = projects;
        _files = files ?? (projects as ProjectService)?.FileService ?? throw new ArgumentException("An explicit file service is required.", nameof(files));
        _entities = entities ?? (projects is ProjectService ? new EntityService(projects) : throw new ArgumentException("An explicit entity service is required.", nameof(entities)));
    }

    public ActStructure Build(BookData book)
    {
        var issues = new List<ActIssue>();
        var metadata = new Dictionary<string, ActData>(StringComparer.OrdinalIgnoreCase);
        foreach (var act in book.Acts)
        {
            if (string.IsNullOrWhiteSpace(act.Name)) issues.Add(new("blank-act-name", act.Name));
            else if (!metadata.TryAdd(act.Name, act)) issues.Add(new("duplicate-act-name", act.Name));
        }
        var groups = new List<ActGroup>();
        foreach (var chapter in book.Chapters.OrderBy(c => c.Order))
        {
            var name = string.IsNullOrWhiteSpace(chapter.Act) ? null : chapter.Act;
            if (groups.Count > 0 && Same(groups[^1].Name, name))
                groups[^1] = groups[^1] with { ChapterGuids = groups[^1].ChapterGuids.Add(chapter.Guid) };
            else
            {
                metadata.TryGetValue(name ?? string.Empty, out var act);
                groups.Add(new(act?.Name ?? name, [chapter.Guid], Clone(act)));
            }
        }
        var populated = groups.Select(g => g.Name).OfType<string>().ToList();
        foreach (var name in populated.Distinct(StringComparer.OrdinalIgnoreCase))
            if (populated.Count(n => Same(n, name)) > 1) issues.Add(new("interleaved-act", name));
        var declaredOrder = book.Acts.Where(a => populated.Contains(a.Name, StringComparer.OrdinalIgnoreCase)).Select(a => a.Name);
        var actualOrder = populated.Where(n => metadata.ContainsKey(n)).Distinct(StringComparer.OrdinalIgnoreCase);
        if (!declaredOrder.SequenceEqual(actualOrder, StringComparer.OrdinalIgnoreCase)) issues.Add(new("act-order-mismatch", null));
        foreach (var act in metadata.Values.Where(a => !populated.Contains(a.Name, StringComparer.OrdinalIgnoreCase)))
        {
            var next = book.Acts.Skip(book.Acts.IndexOf(act) + 1).FirstOrDefault(a => populated.Contains(a.Name, StringComparer.OrdinalIgnoreCase));
            var index = next == null ? groups.Count : groups.FindIndex(g => Same(g.Name, next.Name));
            groups.Insert(index, new(act.Name, [], Clone(act)));
        }
        return new(groups.ToImmutableArray(), issues.ToImmutableArray());
    }

    public ActValidation ValidateRename(BookData book, string oldName, string newName)
    {
        if (string.IsNullOrWhiteSpace(newName) || newName != newName.Trim()) return Invalid("invalid-act-name");
        if (!Names(book).Any(n => Same(n, oldName))) return Invalid("act-not-found");
        if (!Same(oldName, newName) && Names(book).Any(n => Same(n, newName))) return Invalid("duplicate-act-name");
        var source = book.Premise.Acts.Where(p => Same(p.Key, oldName)).ToArray();
        var destination = book.Premise.Acts.Where(p => Same(p.Key, newName)).ToArray();
        if (source.Select(s => s.Value).Distinct().Skip(1).Any() || (!Same(oldName, newName) && destination.Any(d => source.Length == 0 || source.Any(s => d.Value != s.Value))))
            return new(false, "conflicting-reference", ["premise"]);
        return new(true, null, []);
    }

    public async Task<ActValidation> ValidateRenameAsync(string oldName, string newName, CancellationToken ct = default)
    {
        var book = RequireBook();
        var draft = book.ActiveDraftId;
        var validation = ValidateRename(book, oldName, newName);
        if (!validation.IsValid) return validation;
        var references = await LoadReferencesAsync(book, ct);
        EnsureOwner(book, draft, ct);
        return ValidateReferences(references, oldName, newName);
    }

    public Task<ActMutationResult> CreateAsync(string name, string? beforeActName, CancellationToken ct = default)
        => MutateAsync(book =>
        {
            if (string.IsNullOrWhiteSpace(name) || name != name.Trim()) throw new InvalidOperationException("invalid-act-name");
            if (Names(book).Any(n => Same(n, name))) throw new InvalidOperationException("duplicate-act-name");
            MaterializeActs(book);
            var index = Destination(book, beforeActName);
            book.Acts.Insert(index, new() { Name = name });
        }, ct);

    public Task<ActMutationResult> RemoveAsync(string name, CancellationToken ct = default)
        => MutateAsync(book =>
        {
            RequireAct(book, name);
            book.Acts.RemoveAll(a => Same(a.Name, name));
            foreach (var chapter in book.Chapters.Where(c => Same(c.Act, name))) chapter.Act = string.Empty;
        }, ct);

    public Task<ActMutationResult> MoveAsync(string name, string? beforeActName, CancellationToken ct = default)
        => MutateAsync(book =>
        {
            RequireAct(book, name);
            MaterializeActs(book);
            Destination(book, beforeActName);
            if (Same(name, beforeActName)) return;
            var act = book.Acts.Single(a => Same(a.Name, name));
            book.Acts.Remove(act);
            book.Acts.Insert(Destination(book, beforeActName), act);
            var ordered = book.Chapters.OrderBy(c => c.Order).ToList();
            var moving = ordered.Where(c => Same(c.Act, name)).ToList();
            if (moving.Count == 0) return;
            ordered.RemoveAll(c => Same(c.Act, name));
            var next = book.Acts.Skip(book.Acts.IndexOf(act) + 1).FirstOrDefault(a => ordered.Any(c => Same(c.Act, a.Name)));
            var index = next == null ? ordered.Count : ordered.FindIndex(c => Same(c.Act, next.Name));
            ordered.InsertRange(index, moving);
            SetOrder(ordered);
        }, ct);

    public async Task<ActMutationResult> RenameAsync(string oldName, string newName, CancellationToken ct = default)
    {
        var book = RequireBook();
        var before = Snapshot(book);
        RequireValid(book);
        var validation = ValidateRename(book, oldName, newName);
        if (!validation.IsValid) throw new InvalidOperationException(validation.ErrorCode);
        var references = await LoadReferencesAsync(book, ct);
        var retained = await IsRetainedAsync(book, oldName, ct);
        EnsureOwner(book, before.DraftId, ct);
        validation = ValidateReferences(references, oldName, newName);
        if (!validation.IsValid) throw new InvalidOperationException(validation.ErrorCode + ": " + string.Join(", ", validation.ConflictingReferenceScopes));
        var changes = references.Select(r => r.Rename(oldName, newName, retained)).OfType<ActMetadataChange>().ToImmutableArray();
        RenamePremise(book, oldName, newName, retained);
        foreach (var act in book.Acts.Where(a => Same(a.Name, oldName))) act.Name = newName;
        foreach (var chapter in book.Chapters.Where(c => Same(c.Act, oldName))) chapter.Act = newName;
        return await PersistAsync(book, before, references, changes);
    }

    public ActRegroupPreview PreviewRegroup(BookData book)
    {
        var before = book.Chapters.OrderBy(c => c.Order).ToList();
        var after = new List<string>();
        var emitted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var chapter in before)
        {
            if (string.IsNullOrWhiteSpace(chapter.Act)) after.Add(chapter.Guid);
            else if (emitted.Add(chapter.Act)) after.AddRange(before.Where(c => Same(c.Act, chapter.Act)).Select(c => c.Guid));
        }
        return new(book.Id, book.ActiveDraftId, Snapshot(book).RevisionToken, before.Select(c => c.Guid).ToImmutableArray(), after.ToImmutableArray());
    }

    public Task<ActMutationResult> ApplyRegroupAsync(string revisionToken, CancellationToken ct = default)
        => MutateAsync(book =>
        {
            var preview = PreviewRegroup(book);
            if (preview.RevisionToken != revisionToken) throw new InvalidOperationException("stale-act-preview");
            if (Build(book).Issues.Any(i => i.Code is "duplicate-act-name" or "blank-act-name")) throw new InvalidOperationException("ambiguous-act-metadata");
            var byId = book.Chapters.ToDictionary(c => c.Guid);
            SetOrder(preview.AfterChapterGuids.Select(id => byId[id]).ToList());
            MaterializeActs(book);
            var groups = Build(book).Groups;
            book.Acts = groups.Where(g => g.Name != null).Select(g => book.Acts.Single(a => Same(a.Name, g.Name))).ToList();
        }, ct, allowRepair: true);

    public async Task<ActMutationResult> RestoreMutationAsync(ActMutationResult mutation, bool undo, CancellationToken ct = default)
    {
        var book = RequireBook();
        var before = Snapshot(book);
        var expected = undo ? mutation.After : mutation.Before;
        var target = undo ? mutation.Before : mutation.After;
        if (before.BookId != target.BookId || before.DraftId != target.DraftId || before.RevisionToken != expected.RevisionToken
            || target.RevisionToken != Revision(target.BookId, target.DraftId, target.Chapters, target.ActsJson, target.PremiseActsJson)
            || !before.Chapters.Select(c => c.Guid).Order().SequenceEqual(target.Chapters.Select(c => c.Guid).Order()))
            throw new InvalidOperationException("stale-act-mutation");
        var references = mutation.MetadataChanges.Length == 0 ? [] : await LoadReferencesAsync(book, ct);
        EnsureOwner(book, before.DraftId, ct);
        foreach (var change in mutation.MetadataChanges)
        {
            var reference = references.SingleOrDefault(r => r.Scope == change.Scope) ?? throw new InvalidOperationException("act-reference-missing");
            if (reference.ReadJson() != (undo ? change.AfterJson : change.BeforeJson)) throw new InvalidOperationException("act-reference-changed");
            reference.ValidateJson(undo ? change.BeforeJson : change.AfterJson);
        }
        Restore(book, target);
        var changes = mutation.MetadataChanges.Select(c => undo ? new ActMetadataChange(c.Scope, c.AfterJson, c.BeforeJson) : c).ToImmutableArray();
        foreach (var change in changes) references.Single(r => r.Scope == change.Scope).ReplaceJson(change.AfterJson);
        return await PersistAsync(book, before, references, changes);
    }

    private async Task<ActMutationResult> MutateAsync(Action<BookData> mutate, CancellationToken ct, bool allowRepair = false)
    {
        ct.ThrowIfCancellationRequested();
        var book = RequireBook();
        if (!allowRepair) RequireValid(book);
        var before = Snapshot(book);
        try { mutate(book); }
        catch { Restore(book, before); throw; }
        return await PersistAsync(book, before, [], []);
    }

    private async Task<ActMutationResult> PersistAsync(BookData book, ActStructureSnapshot before,
        IReadOnlyList<ReferenceDocument> references, ImmutableArray<ActMetadataChange> changes)
    {
        try
        {
            foreach (var reference in references.Where(r => changes.Any(c => c.Scope == r.Scope))) await reference.Save();
            await _projects.SaveProjectAsync();
        }
        catch
        {
            Restore(book, before);
            foreach (var reference in references.Where(r => changes.Any(c => c.Scope == r.Scope))) await reference.Restore();
            await _projects.SaveProjectAsync();
            throw;
        }
        var after = Snapshot(book);
        var affected = before.Chapters.Where(c => !after.Chapters.Contains(c)).Select(c => c.Guid).ToImmutableArray();
        return new(affected, before, after, changes);
    }

    private BookData RequireBook() => _projects.ActiveBook ?? throw new InvalidOperationException("no-active-book");
    private void EnsureOwner(BookData book, string draft, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (!ReferenceEquals(book, _projects.ActiveBook) || book.ActiveDraftId != draft) throw new InvalidOperationException("act-context-changed");
    }
    private void RequireValid(BookData book)
    {
        if (Build(book).Issues.Length > 0) throw new InvalidOperationException("act-repair-required");
    }
    private static IEnumerable<string> Names(BookData book) => book.Acts.Select(a => a.Name).Concat(book.Chapters.Select(c => c.Act)).Where(n => !string.IsNullOrWhiteSpace(n));
    private static void RequireAct(BookData book, string name)
    {
        if (!Names(book).Any(n => Same(n, name))) throw new InvalidOperationException("act-not-found");
    }
    private static int Destination(BookData book, string? name)
    {
        if (name == null) return book.Acts.Count;
        var index = book.Acts.FindIndex(a => Same(a.Name, name));
        return index < 0 ? throw new InvalidOperationException("act-not-found") : index;
    }
    private static void SetOrder(List<ChapterData> chapters)
    {
        for (var index = 0; index < chapters.Count; index++) chapters[index].Order = index;
    }
    private static void MaterializeActs(BookData book)
    {
        var names = book.Chapters.OrderBy(c => c.Order).Select(c => c.Act).Where(n => !string.IsNullOrWhiteSpace(n)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        foreach (var name in names)
            if (!book.Acts.Any(a => Same(a.Name, name)))
            {
                var next = names.Skip(names.IndexOf(name) + 1).FirstOrDefault(n => book.Acts.Any(a => Same(a.Name, n)));
                book.Acts.Insert(next == null ? book.Acts.Count : book.Acts.FindIndex(a => Same(a.Name, next)), new() { Name = name });
            }
    }
    private static ActValidation Invalid(string code) => new(false, code, []);
    private static ActData? Clone(ActData? act) => act == null ? null : new() { Name = act.Name, WordTarget = act.WordTarget, DateRange = act.DateRange?.Clone() };
    private static ActStructureSnapshot Snapshot(BookData book)
    {
        var chapters = book.Chapters.OrderBy(c => c.Order).Select(c => new ActChapterSnapshot(c.Guid, c.Order, c.Act)).ToImmutableArray();
        var acts = JsonSerializer.Serialize(book.Acts);
        var premise = JsonSerializer.Serialize(book.Premise.Acts);
        var revision = Revision(book.Id, book.ActiveDraftId, chapters, acts, premise);
        return new(book.Id, book.ActiveDraftId, revision, chapters, acts, premise);
    }
    private static string Revision(string bookId, string draftId, ImmutableArray<ActChapterSnapshot> chapters, string acts, string premise)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { Id = bookId, ActiveDraftId = draftId, chapters, acts, premise }))));
    private static void Restore(BookData book, ActStructureSnapshot snapshot)
    {
        var acts = Read<List<ActData>>(snapshot.ActsJson);
        var premise = Read<Dictionary<string, string>>(snapshot.PremiseActsJson);
        foreach (var chapter in book.Chapters)
        {
            var original = snapshot.Chapters.Single(c => c.Guid == chapter.Guid);
            chapter.Act = original.Act;
            chapter.Order = original.Order;
        }
        book.Acts = acts;
        book.Premise.Acts = premise;
    }
    private static T Read<T>(string json) where T : class => JsonSerializer.Deserialize<T>(json) ?? throw new InvalidDataException("Invalid act snapshot.");

    private static void RenamePremise(BookData book, string oldName, string newName, bool retain)
    {
        foreach (var key in book.Premise.Acts.Keys.Where(k => Same(k, oldName)).ToArray())
        {
            var value = book.Premise.Acts[key];
            if (!retain || Same(oldName, newName)) book.Premise.Acts.Remove(key);
            if (!book.Premise.Acts.Keys.Any(k => Same(k, newName))) book.Premise.Acts[newName] = value;
        }
    }

    private async Task<bool> IsRetainedAsync(BookData active, string name, CancellationToken ct)
    {
        var project = _projects.CurrentProject ?? throw new InvalidOperationException("no-project");
        foreach (var book in project.Books)
        {
            if (!ReferenceEquals(book, active) && Names(book).Any(n => Same(n, name))) return true;
            var root = _projects.BookRootFor(book) ?? throw new InvalidOperationException("no-book-root");
            foreach (var draft in book.Drafts.Where(d => !ReferenceEquals(book, active) || d.Id != active.ActiveDraftId))
            {
                ct.ThrowIfCancellationRequested();
                var path = _files.CombinePath(root, "Drafts", draft.FolderName, "draft.json");
                var data = JsonSerializer.Deserialize<BookDraftData>(await _files.ReadTextAsync(path)) ?? throw new InvalidDataException("Invalid draft data.");
                if (data.Acts.Any(a => Same(a.Name, name)) || data.Chapters.Any(c => Same(c.Act, name))) return true;
            }
        }
        return false;
    }

    private static ActValidation ValidateReferences(IReadOnlyList<ReferenceDocument> references, string oldName, string newName)
    {
        var conflicts = references.Where(r => r.Conflicts(oldName, newName)).Select(r => r.Scope).ToImmutableArray();
        return conflicts.Length == 0 ? new(true, null, []) : new(false, "conflicting-reference", conflicts);
    }

    private async Task<List<ReferenceDocument>> LoadReferencesAsync(BookData book, CancellationToken ct)
    {
        var references = new List<ReferenceDocument>();
        bool InDraft(string? chapter) => string.IsNullOrWhiteSpace(chapter) || book.Chapters.Any(c => Same(c.Guid, chapter) || Same(c.Title, chapter));
        foreach (var character in await _entities.LoadCharactersAsync())
        {
            AddEntity(references, character, () => _entities.SaveCharacterAsync(character), InDraft);
            references.Add(ReferenceDocument.Create($"character/{character.Id}/chapterOverrides", character.ChapterOverrides,
                o => o.Act, (o, value) => o.Act = value, o => $"{o.Chapter}\0{o.Scene}", () => _entities.SaveCharacterAsync(character), o => InDraft(o.Chapter)));
        }
        foreach (var entity in await _entities.LoadLocationsAsync()) AddEntity(references, entity, () => _entities.SaveLocationAsync(entity), InDraft);
        foreach (var entity in await _entities.LoadItemsAsync()) AddEntity(references, entity, () => _entities.SaveItemAsync(entity), InDraft);
        foreach (var entity in await _entities.LoadLoreAsync()) AddEntity(references, entity, () => _entities.SaveLoreAsync(entity), InDraft);
        foreach (var type in _entities.GetCustomEntityTypes())
            foreach (var entity in await _entities.LoadCustomEntitiesAsync(type.TypeKey)) AddEntity(references, entity, () => _entities.SaveCustomEntityAsync(entity), InDraft);
        ct.ThrowIfCancellationRequested();
        var root = _projects.ProjectRoot ?? throw new InvalidOperationException("no-project");
        var path = _files.CombinePath(root, ".novalist", "narration", "cast.json");
        if (await _files.ExistsAsync(path))
        {
            var sheet = JsonSerializer.Deserialize<VoiceCastSheet>(await _files.ReadTextAsync(path), CastOptions) ?? throw new InvalidDataException("Invalid cast data.");
            references.Add(ReferenceDocument.Create("narration", sheet.Overrides, o => o.Act, (o, value) => o.Act = value,
                o => $"{o.CharacterId}\0{o.Chapter}\0{o.Scene}", () => _files.WriteTextAsync(path, JsonSerializer.Serialize(sheet, CastOptions)), o => InDraft(o.Chapter)));
        }
        return references;
    }

    private static void AddEntity(List<ReferenceDocument> references, IEntityData entity, Func<Task> save, Func<string?, bool> inDraft)
        => references.Add(ReferenceDocument.Create($"entity/{entity.GetType().Name}/{entity.Id}/stateOverrides", entity.StateOverrides,
            o => o.Act, (o, value) => o.Act = value, o => $"{o.Chapter}\0{o.Scene}", save, o => inDraft(o.Chapter), o => o.Id = Guid.NewGuid().ToString("N")));

    private sealed class ReferenceDocument
    {
        public required string Scope { get; init; }
        public required Func<string, string, bool> Conflicts { get; init; }
        public required Func<string, string, bool, ActMetadataChange?> Rename { get; init; }
        public required Func<Task> Save { get; init; }
        public required Func<Task> Restore { get; init; }
        public required Func<string> ReadJson { get; init; }
        public required Action<string> ValidateJson { get; init; }
        public required Action<string> ReplaceJson { get; init; }
        public static ReferenceDocument Create<T>(string scope, List<T> values, Func<T, string?> act,
            Action<T, string> setAct, Func<T, string> key, Func<Task> save, Func<T, bool> inDraft, Action<T>? regenerateId = null)
            where T : class
        {
            var before = JsonSerializer.Serialize(values);
            string Payload(T value)
            {
                var copy = Read<T>(JsonSerializer.Serialize(value));
                setAct(copy, string.Empty);
                if (copy is EntityStateOverride entity) entity.Id = string.Empty;
                return JsonSerializer.Serialize(copy);
            }
            bool Conflicts(string oldName, string newName)
            {
                var source = values.Where(v => inDraft(v) && Same(act(v), oldName)).ToList();
                return source.GroupBy(key, StringComparer.OrdinalIgnoreCase).Any(g => g.Select(Payload).Distinct().Skip(1).Any())
                    || (!Same(oldName, newName) && values.Where(v => inDraft(v) && Same(act(v), newName))
                        .Any(target => !source.Any(s => Same(key(s), key(target)) && Payload(s) == Payload(target))));
            }
            ActMetadataChange? Rename(string oldName, string newName, bool retain)
            {
                foreach (var source in values.Where(v => inDraft(v) && Same(act(v), oldName)).ToArray())
                {
                    if (Same(oldName, newName)) { setAct(source, newName); continue; }
                    if (!values.Any(target => Same(act(target), newName) && Same(key(source), key(target))))
                    {
                        var copy = Read<T>(JsonSerializer.Serialize(source));
                        setAct(copy, newName);
                        if (retain) regenerateId?.Invoke(copy);
                        values.Add(copy);
                    }
                    if (!retain) values.Remove(source);
                }
                var after = JsonSerializer.Serialize(values);
                return before == after ? null : new(scope, before, after);
            }
            async Task Restore()
            {
                values.Clear();
                values.AddRange(Read<List<T>>(before));
                await save();
            }
            void ValidateJson(string json) => _ = Read<List<T>>(json);
            void ReplaceJson(string json)
            {
                values.Clear();
                values.AddRange(Read<List<T>>(json));
            }
            return new() { Scope = scope, Conflicts = Conflicts, Rename = Rename, Save = save, Restore = Restore,
                ReadJson = () => JsonSerializer.Serialize(values), ValidateJson = ValidateJson, ReplaceJson = ReplaceJson };
        }
    }
}
