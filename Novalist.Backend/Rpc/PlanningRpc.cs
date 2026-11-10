using System.Collections.Immutable;
using Novalist.Core.Models;
using Novalist.Core.Services;
using StreamJsonRpc;

namespace Novalist.Backend.Rpc;

public sealed class PlanningRpc(Workspace workspace)
{
    [JsonRpcMethod("planning/get")]
    public PlanningStateDto Get()
    {
        var book = workspace.Projects.ActiveBook ?? throw new InvalidOperationException("No project open.");
        var service = new ActStructureService(workspace.Projects);
        var structure = service.Build(book);
        return new(book.Id, book.ActiveDraftId, service.PreviewRegroup(book).RevisionToken,
            structure.Groups, structure.Issues, workspace.BuildState().Chapters);
    }
}

public sealed record PlanningStateDto(string BookId, string DraftId, string StructureRevision,
    ImmutableArray<ActGroup> Acts, ImmutableArray<ActIssue> Issues, IReadOnlyList<ChapterDto> Chapters);
