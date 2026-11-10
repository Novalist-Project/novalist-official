using Novalist.Core.Models;
using Novalist.Core.Services;
using StreamJsonRpc;

namespace Novalist.Backend.Rpc;

public sealed partial class ScenesRpc
{
    [JsonRpcMethod("scenes/readPassive")]
    public async Task<SceneContentDto> ReadPassiveAsync(string bookId, string draftId, string chapterGuid, string sceneId)
    {
        var reference = new SceneRef(bookId, draftId, chapterGuid, sceneId);
        var reader = new SceneDocumentReader(_workspace.Projects, _workspace.FileService);
        var resolved = await reader.ResolveAsync(reference);
#if NOVALIST_COLLABORATION
        var shared = await _workspace.ReadSharedScenePathAsync(resolved.Path, sceneId, CancellationToken.None);
        if (shared is not null) return shared;
#endif
        var snapshot = await reader.ReadAsync(reference);
        return new(sceneId, snapshot.Html, snapshot.Hash);
    }

    [JsonRpcMethod("scenes/setFocusedWritingOwner")]
    public void SetFocusedWritingOwner(string owner, string sourceId, long expectedEpoch, long generation)
        => _workspace.SetWritingFocus(owner, sourceId, expectedEpoch, generation);

    [JsonRpcMethod("scenes/activate")]
    public bool Activate(string bookId, string draftId, string chapterGuid, string sceneId,
        long expectedEpoch, string sourceId, long focusGeneration, long activationGeneration)
    {
        var book = _workspace.Projects.ActiveBook;
        if (book?.Id != bookId || book.ActiveDraftId != draftId) return false;
        if (!_workspace.AcceptWritingActivation(sourceId, expectedEpoch, focusGeneration, activationGeneration)) return false;
        var (chapter, scene) = _workspace.ResolveScene(chapterGuid, sceneId);
        using ((_workspace.FileService as IFileReadCache)?.UseFreshReads())
            _workspace.RaiseSceneOpened(chapter, scene);
        return true;
    }

}
