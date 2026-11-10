namespace Novalist.Core.Models;

public sealed record SceneRef(string BookId, string DraftId, string ChapterGuid, string SceneId);

public sealed record WritingSceneSnapshot(SceneRef Ref, string Html, string Hash, long Revision);
