using System.Collections.Immutable;

namespace Novalist.Core.Models;

public sealed record ActGroup(string? Name, ImmutableArray<string> ChapterGuids, ActData? Metadata);
public sealed record ActIssue(string Code, string? ActName);
public sealed record ActStructure(ImmutableArray<ActGroup> Groups, ImmutableArray<ActIssue> Issues);
public sealed record ActValidation(bool IsValid, string? ErrorCode, ImmutableArray<string> ConflictingReferenceScopes);
public sealed record ActChapterSnapshot(string Guid, int Order, string Act);
public sealed record ActStructureSnapshot(string BookId, string DraftId, string RevisionToken,
    ImmutableArray<ActChapterSnapshot> Chapters, string ActsJson, string PremiseActsJson);
public sealed record ActMetadataChange(string Scope, string BeforeJson, string AfterJson);
public sealed record ActMutationResult(ImmutableArray<string> AffectedChapterGuids,
    ActStructureSnapshot Before, ActStructureSnapshot After, ImmutableArray<ActMetadataChange> MetadataChanges);
public sealed record ActRegroupPreview(string BookId, string DraftId, string RevisionToken,
    ImmutableArray<string> BeforeChapterGuids, ImmutableArray<string> AfterChapterGuids);
