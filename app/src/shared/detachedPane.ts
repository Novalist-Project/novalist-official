export interface DetachedPaneRequest {
  view: string
  projectPath: string | null
  chapterGuid: string | null
  sceneId: string | null
  bookId?: string | null
  draftId?: string | null
  writingScope?: 'scene' | 'chapter' | 'manuscript'
  selectedSceneIds?: string[] | null
}

export function normalizeDetachedPaneRequest(input: unknown): DetachedPaneRequest {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const text = (key: string): string | null => typeof value[key] === 'string' ? value[key] as string : null
  return {
    view: typeof value.view === 'string' && /^[a-zA-Z]{1,40}$/.test(value.view) ? value.view : 'write',
    projectPath: text('projectPath'), chapterGuid: text('chapterGuid'), sceneId: text('sceneId'),
    bookId: text('bookId'), draftId: text('draftId'),
    writingScope: value.writingScope === 'scene' || value.writingScope === 'chapter' ? value.writingScope : 'manuscript',
    selectedSceneIds: Array.isArray(value.selectedSceneIds) && value.selectedSceneIds.every(id => typeof id === 'string')
      ? [...new Set(value.selectedSceneIds as string[])] : null
  }
}

export function readDetachedPaneQuery(params: URLSearchParams): DetachedPaneRequest {
  let selectedSceneIds: unknown = null
  try { selectedSceneIds = JSON.parse(params.get('selectedScenes') ?? 'null') }
  catch { selectedSceneIds = null }
  return normalizeDetachedPaneRequest({ view: params.get('pane'), projectPath: params.get('project'),
    chapterGuid: params.get('chapter'), sceneId: params.get('scene'), bookId: params.get('book'),
    draftId: params.get('draft'), writingScope: params.get('writingScope'), selectedSceneIds })
}
