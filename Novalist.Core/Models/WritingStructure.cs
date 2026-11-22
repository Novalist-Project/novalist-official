using System.Text.Json.Serialization;
using Novalist.Core.Services;

namespace Novalist.Core.Models;

[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(SplitSceneCommand), "splitScene")]
[JsonDerivedType(typeof(SplitChapterCommand), "splitChapter")]
[JsonDerivedType(typeof(InsertChapterCommand), "insertChapter")]
[JsonDerivedType(typeof(InsertSceneCommand), "insertScene")]
[JsonDerivedType(typeof(MoveScenesCommand), "moveScenes")]
[JsonDerivedType(typeof(MoveChaptersCommand), "moveChapters")]
[JsonDerivedType(typeof(CreateActCommand), "createAct")]
[JsonDerivedType(typeof(RenameActCommand), "renameAct")]
[JsonDerivedType(typeof(RemoveActCommand), "removeAct")]
[JsonDerivedType(typeof(MoveActCommand), "moveAct")]
[JsonDerivedType(typeof(RegroupActsCommand), "regroupActs")]
public abstract record StructureCommand;
public sealed record SplitSceneCommand(SceneRef Ref, string BeforeHtml, string AfterHtml, string SourceHtml, string ExpectedHash) : StructureCommand
{
    public SharedSplitPreparation? SharedSplit { get; init; }
}
public sealed record SplitChapterCommand(SceneRef Ref, string Title, string BeforeHtml, string AfterHtml, string SourceHtml, string ExpectedHash) : StructureCommand
{
    public SharedSplitPreparation? SharedSplit { get; init; }
}
public sealed record InsertChapterCommand(string Title, string? BeforeChapterGuid, string? ActName, StoryDateRange? DateRange = null) : StructureCommand;
public sealed record InsertSceneCommand(string ChapterGuid, string Title, string? BeforeSceneId) : StructureCommand;
public sealed record MoveScenesCommand(string[] SceneIds, string TargetChapterGuid, string? BeforeSceneId) : StructureCommand;
public sealed record MoveChaptersCommand(string[] ChapterGuids, string? BeforeChapterGuid, string? TargetActName) : StructureCommand;
public sealed record CreateActCommand(string Name, string? BeforeActName) : StructureCommand;
public sealed record RenameActCommand(string OldName, string NewName) : StructureCommand;
public sealed record RemoveActCommand(string Name) : StructureCommand;
public sealed record MoveActCommand(string Name, string? BeforeActName) : StructureCommand;
public sealed record RegroupActsCommand(string PreviewToken, string ExpectedStructureRevision) : StructureCommand;
public sealed record StructureRequest(string TransactionId, long ExpectedEpoch, string BookId, string DraftId, StructureCommand Command);
public sealed record StructureCommit(string OperationId, WritingSceneHash[] Hashes, SceneRef? FocusScene);
public sealed record StructurePlan(WritingFileMutation[] Files, WritingSceneHash[] Hashes, SceneRef? FocusScene);
public sealed record WritingStructureContext(string BookId, string DraftId);
public sealed record SharedSplitPreparation(Guid SessionId, Guid ItemId, byte[] SourceState, byte[] RetainedUpdate,
    Guid CreatedItemId, byte[] CreatedState, byte[] UndoUpdate);
public sealed record SharedStructureInverse(Guid SessionId, Guid ItemId, byte[] SourceState, byte[] Update,
    Guid? CreatedItemId = null, byte[]? CreatedState = null);
