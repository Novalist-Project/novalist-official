namespace Novalist.Core.Models;

public sealed record WritingSearchRequest(FindOptions Options, SceneRef[] Targets,
    WritingSceneSnapshot[] Overrides, long ExpectedEpoch);

public sealed record WritingMatch(SceneRef Ref, string Field, int Index, int Length,
    string Hash, long Revision, string Before, string MatchedText, string After);

public sealed record WritingSearchTarget(SceneRef Ref, string BookTitle, string ChapterTitle, string SceneTitle);
