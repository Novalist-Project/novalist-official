using System.Text.Json;
using Novalist.Core.Models;

namespace Novalist.Core.Services;

public sealed partial class ManuscriptStructureService
{
    private readonly ProjectService projects;
    public ManuscriptStructureService(ProjectService projects) => this.projects = projects;
    private string Root => projects.ProjectRoot ?? throw new InvalidOperationException("No project open.");
    private WritingOperationJournal Journal => new(Root, projects.FileService);
    private sealed record HistoryState(bool Undone, int Sequence);

    public async Task<StructureCommit> ExecuteAsync(StructureRequest request, CancellationToken ct = default)
    {
        RequireContext(request.BookId, request.DraftId);
        var journal = Journal;
        await journal.RecoverAsync(ct);
        var fingerprint = WritingOperationJournal.OperationId(JsonSerializer.Serialize(new { request.BookId, request.DraftId, request.Command }));
        var previous = await journal.FindAsync(request.TransactionId, fingerprint);
        if (previous?.State == "committed")
        {
            await projects.ReloadWritingStructureAsync();
            return new(previous.OperationId, previous.Hashes, previous.FocusScene);
        }
        await projects.ReloadWritingStructureAsync();
        var plan = await PlanAsync(request, ct);
        var context = new WritingStructureContext(request.BookId, request.DraftId);
        var marker = new WritingFileMutation(Path.Combine(Root, ".novalist", "writing-structure", WritingOperationJournal.OperationId(request.TransactionId) + ".json"), null, JsonSerializer.Serialize(context));
        var operation = await journal.PrepareAsync(request.TransactionId, fingerprint, [.. plan.Files, marker], ct, plan.Hashes, new(plan.FocusScene, context));
        await journal.CommitAsync(operation, ct);
        await projects.ReloadWritingStructureAsync();
        return new(operation.OperationId, plan.Hashes, plan.FocusScene);
    }

    public async Task<StructureCommit> RestoreAsync(string operationId, bool undo, CancellationToken ct = default)
    {
        var journal = Journal;
        await journal.RecoverAsync(ct);
        var original = await journal.ReadOperationAsync(operationId);
        if (original.Structure is not { } context) throw new InvalidOperationException("This operation is not a structural change.");
        RequireContext(context.BookId, context.DraftId);
        if (original.State != "committed") throw new InvalidOperationException("The structure operation has not committed.");
        var markerPath = Path.Combine(Root, ".novalist", "writing-history", operationId + ".json");
        var marker = await projects.FileService.ExistsAsync(markerPath) ? await projects.FileService.ReadTextAsync(markerPath) : null;
        var state = marker is null ? new(false, 0) : JsonSerializer.Deserialize<HistoryState>(marker) ?? throw new InvalidDataException("Invalid structure history.");
        if (state.Undone != undo)
        {
            var mutations = original.Files.Select(file => new WritingFileMutation(Path.Combine(Root, file.Path), undo ? file.After : file.Before, undo ? file.Before : file.After)).ToList();
            mutations.Add(new(markerPath, marker, JsonSerializer.Serialize(new HistoryState(undo, state.Sequence + 1))));
            var transaction = $"structure-history:{operationId}:{state.Sequence + 1}";
            var operation = await journal.PrepareAsync(transaction, WritingOperationJournal.OperationId(JsonSerializer.Serialize(mutations)), mutations, ct);
            await journal.CommitAsync(operation, ct);
        }
        await projects.ReloadWritingStructureAsync();
        return new(operationId, [], undo ? null : original.FocusScene);
    }

    public async Task<StructurePlan> PlanAsync(StructureRequest request, CancellationToken ct = default)
    {
        RequireContext(request.BookId, request.DraftId);
        ct.ThrowIfCancellationRequested();
        var files = new StagedFileService(projects.FileService);
        var staged = projects.CreateStaged(files);
        var acts = new ActStructureService(staged);
        if (request.Command is not RegroupActsCommand && acts.Build(RequireBook(staged)).Issues.Length != 0)
            throw new InvalidOperationException("act-repair-required");
        var focus = await ApplyAsync(staged, acts, request.Command, ct);
        if (acts.Build(RequireBook(staged)).Issues.Length != 0) throw new InvalidOperationException("invalid-act-destination");
        ct.ThrowIfCancellationRequested();
        var hashes = new List<WritingSceneHash>();
        foreach (var chapter in staged.GetChaptersOrdered())
            foreach (var scene in staged.GetScenesForChapter(chapter.Guid))
                if (files.Changes.Any(change => change.Path.Equals(staged.GetSceneFilePath(chapter, scene), StringComparison.OrdinalIgnoreCase)))
                    hashes.Add(new(new(request.BookId, request.DraftId, chapter.Guid, scene.Id), ContentHasher.Hash(await staged.ReadSceneContentAsync(chapter, scene))));
        return new(files.Changes, hashes.ToArray(), focus);
    }

    private void RequireContext(string bookId, string draftId)
    {
        if (projects.ActiveBook is not { } book || book.Id != bookId || book.ActiveDraftId != draftId)
            throw new InvalidOperationException("writing.workspaceChanged");
    }

    private static async Task<SceneRef?> ApplyAsync(ProjectService staged, ActStructureService acts, StructureCommand command, CancellationToken ct)
    {
        switch (command)
        {
            case SplitSceneCommand split: return await SplitAsync(staged, split, null);
            case SplitChapterCommand split: return await SplitAsync(staged, new(split.Ref, split.BeforeHtml, split.AfterHtml, split.SourceHtml, split.ExpectedHash), split.Title);
            case InsertChapterCommand insert: return await InsertAsync(staged, insert);
            case InsertSceneCommand insert: return await InsertSceneAsync(staged, insert);
            case MoveScenesCommand move: await MoveScenesAsync(staged, move); break;
            case MoveChaptersCommand move: await MoveChaptersAsync(staged, move); break;
            case CreateActCommand create: await acts.CreateAsync(create.Name, create.BeforeActName, ct); break;
            case RenameActCommand rename: await acts.RenameAsync(rename.OldName, rename.NewName, ct); break;
            case RemoveActCommand remove: await acts.RemoveAsync(remove.Name, ct); break;
            case MoveActCommand move: await acts.MoveAsync(move.Name, move.BeforeActName, ct); break;
            case RegroupActsCommand regroup:
                if (regroup.PreviewToken != regroup.ExpectedStructureRevision) throw new InvalidOperationException("stale-act-preview");
                await acts.ApplyRegroupAsync(regroup.PreviewToken, ct); break;
            default: throw new InvalidDataException("Unknown structure command.");
        }
        return null;
    }
}
