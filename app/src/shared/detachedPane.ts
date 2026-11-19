export interface DetachedPaneRequest {
  view: string
  projectPath: string | null
  chapterGuid: string | null
  sceneId: string | null
  bookId?: string | null
  draftId?: string | null
  writingScope?: 'scene' | 'chapter' | 'manuscript'
  selectedSceneIds?: string[] | null
  /** The extension view the pane was showing, so it opens on that and not on what lies under it. */
  extView?: { extensionId: string; key: string } | null
  /** Opened from a saved layout or a remembered session: the full content waits in main. */
  restore?: boolean
}

function extensionView(input: unknown): DetachedPaneRequest['extView'] {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : null
  return value && typeof value.extensionId === 'string' && typeof value.key === 'string' &&
    value.extensionId.length > 0 && value.key.length > 0 && value.extensionId.length <= 128 && value.key.length <= 128
    ? { extensionId: value.extensionId, key: value.key } : null
}

export function normalizeDetachedPaneRequest(input: unknown): DetachedPaneRequest {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const text = (key: string): string | null => typeof value[key] === 'string' ? value[key] as string : null
  return {
    extView: extensionView(value.extView),
    restore: value.restore === true,
    view: typeof value.view === 'string' && /^[a-zA-Z]{1,40}$/.test(value.view) ? value.view : 'write',
    projectPath: text('projectPath'), chapterGuid: text('chapterGuid'), sceneId: text('sceneId'),
    bookId: text('bookId'), draftId: text('draftId'),
    writingScope: value.writingScope === 'scene' || value.writingScope === 'chapter' ? value.writingScope : 'manuscript',
    selectedSceneIds: Array.isArray(value.selectedSceneIds) && value.selectedSceneIds.every(id => typeof id === 'string')
      ? [...new Set(value.selectedSceneIds as string[])] : null
  }
}

export function readDetachedPaneQuery(params: URLSearchParams): DetachedPaneRequest {
  const json = (key: string): unknown => {
    try { return JSON.parse(params.get(key) ?? 'null') }
    catch { return null }
  }
  return normalizeDetachedPaneRequest({ view: params.get('pane'), projectPath: params.get('project'),
    chapterGuid: params.get('chapter'), sceneId: params.get('scene'), bookId: params.get('book'),
    draftId: params.get('draft'), writingScope: params.get('writingScope'), selectedSceneIds: json('selectedScenes'),
    extView: json('extView'), restore: params.get('restore') === '1' })
}

/** The query a pane window is loaded with. */
export function detachedPaneQuery(request: DetachedPaneRequest): Record<string, string> {
  const query: Record<string, string> = { pane: request.view }
  if (request.projectPath) query.project = request.projectPath
  if (request.chapterGuid) query.chapter = request.chapterGuid
  if (request.sceneId) query.scene = request.sceneId
  if (request.bookId) query.book = request.bookId
  if (request.draftId) query.draft = request.draftId
  if (request.writingScope) query.writingScope = request.writingScope
  if (request.selectedSceneIds) query.selectedScenes = JSON.stringify(request.selectedSceneIds)
  if (request.extView) query.extView = JSON.stringify(request.extView)
  if (request.restore) query.restore = '1'
  return query
}
