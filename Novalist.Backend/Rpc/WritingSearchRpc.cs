using Novalist.Core.Models;
using Novalist.Core.Services;
using StreamJsonRpc;
using WritingSceneChange = Novalist.Core.Models.SceneChange;

namespace Novalist.Backend.Rpc;

public sealed class WritingSearchRpc(Workspace workspace)
{
    [JsonRpcMethod("writingSearch/targets")]
    public Task<WritingSearchTarget[]> TargetsAsync(string bookId, string draftId, bool projectWide, CancellationToken ct)
        => new WritingSearchCatalog(workspace.Projects, workspace.FileService).ReadAsync(bookId, draftId, projectWide, ct);

    [JsonRpcMethod("writingSearch/find")]
    public async Task<WritingMatch[]> FindAsync(WritingSearchRequest request, CancellationToken ct)
    {
        var prose = FindReplaceService.FindWriting(request.Options, await ReadAsync(request, ct, requireCurrentHash: false));
        var reader = new SceneDocumentReader(workspace.Projects, workspace.FileService);
        var scenes = new List<ResolvedWritingScene>();
        if (request.Options.IncludeSceneNotes)
            foreach (var reference in request.Targets) scenes.Add(await reader.ResolveAsync(reference, ct));
        var service = new FindReplaceService(workspace.Projects, new EntityService(workspace.Projects));
        var extras = await service.FindWritingExtrasAsync(request.Options, scenes);
        ValidateEpoch(request.ExpectedEpoch);
        return [.. prose, .. extras];
    }

    [JsonRpcMethod("writingSearch/prepareReplace")]
    public async Task<WritingSceneChange[]> PrepareReplaceAsync(WritingSearchRequest request,
        WritingMatch[] matches, string replacement, CancellationToken ct)
        => FindReplaceService.PrepareWritingReplace(request.Options, await ReadAsync(request, ct), matches, replacement);

    [JsonRpcMethod("writingSearch/replaceNotes")]
    public async Task<int> ReplaceNotesAsync(WritingSearchRequest request, string replacement, CancellationToken ct)
    {
        await ReadAsync(request, ct);
        var options = new FindOptions { Pattern = request.Options.Pattern, Replacement = replacement,
            MatchCase = request.Options.MatchCase, WholeWord = request.Options.WholeWord, UseRegex = request.Options.UseRegex,
            IncludeSceneNotes = true, Scope = FindScope.Project };
        return await new FindReplaceService(workspace.Projects).ReplaceNotesAsync(options, request.Targets,
            new SnapshotService(workspace.Projects, workspace.FileService), ct);
    }

    private void ValidateEpoch(long epoch)
    {
        if (epoch != (workspace.Coordinator?.Epoch ?? 0))
            throw new InvalidOperationException("The writing workspace changed.");
    }

    private async Task<WritingSceneSnapshot[]> ReadAsync(WritingSearchRequest request, CancellationToken ct,
        bool requireCurrentHash = true)
    {
        ValidateEpoch(request.ExpectedEpoch);
        var overrides = request.Overrides.ToDictionary(snapshot => snapshot.Ref);
        var targets = request.Targets.ToHashSet();
        if (targets.Count != request.Targets.Length || overrides.Keys.Any(reference => !targets.Contains(reference)))
            throw new InvalidOperationException("Search snapshots must belong to distinct target scenes.");
        var reader = new ScenesRpc(workspace);
        var snapshots = new List<WritingSceneSnapshot>();
        foreach (var reference in request.Targets)
        {
            ct.ThrowIfCancellationRequested();
            var stored = await reader.ReadPassiveAsync(reference.BookId, reference.DraftId, reference.ChapterGuid, reference.SceneId);
            if (overrides.TryGetValue(reference, out var pending))
            {
                if ((requireCurrentHash && stored.Shared is null && pending.Hash != stored.Hash) || pending.Revision < 0)
                    throw new InvalidOperationException("The scene changed outside this search snapshot.");
                snapshots.Add(pending);
            }
            else snapshots.Add(new(reference, stored.Html, stored.Hash, 0));
        }
        ValidateEpoch(request.ExpectedEpoch);
        return snapshots.ToArray();
    }
}
