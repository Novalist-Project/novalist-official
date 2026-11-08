import type { ChapterDto, EditorPaneState } from './projectTypes'

/**
 * How much of the book the writing view holds at once.
 *
 * `scene` is the editor Novalist has always had. `chapter` and `manuscript`
 * stack one full scene editor per scene, one below the other, so a writer can
 * move from the end of one scene into the next without opening anything.
 */
export type EditorScope = 'scene' | 'chapter' | 'manuscript'

export const EDITOR_SCOPES: readonly EditorScope[] = ['scene', 'chapter', 'manuscript']

/**
 * Separates a stacked scene's editor id from the shell pane holding the stack.
 *
 * Every scene in a stack has its own entry in the project store's editors, so
 * it saves, conflicts and recovers exactly like a scene opened on its own. The
 * shell knows nothing of them: it sees the one pane, and every id it is handed
 * goes through {@link hostPaneId} first.
 */
const STACK_SEPARATOR = '~'

export function stackedPaneId(hostId: string, sceneId: string): string {
  return `${hostId}${STACK_SEPARATOR}${sceneId}`
}

/** The shell pane an editor id belongs to; a plain pane id is its own host. */
export function hostPaneId(paneId: string): string {
  const at = paneId.indexOf(STACK_SEPARATOR)
  return at < 0 ? paneId : paneId.slice(0, at)
}

export function isStackedPaneId(paneId: string): boolean {
  return paneId.includes(STACK_SEPARATOR)
}

/** Reads a stored scope; anything unknown is the single-scene editor. */
export function normalizeEditorScope(value: unknown): EditorScope {
  return value === 'chapter' || value === 'manuscript' ? value : 'scene'
}

export interface StackMember {
  chapterGuid: string
  chapterTitle: string
  sceneId: string
  /** The editor id this scene is edited under. */
  paneId: string
  /** True for the first scene of its chapter, where a chapter heading goes. */
  opensChapter: boolean
}

/**
 * The scenes a pane's stack holds, in reading order.
 *
 * The scene the pane itself has open keeps the pane's own editor id - it is the
 * scene the binder opened and the tabs know about - and every other scene gets
 * a stacked id under it, so one scene is never held by two editors at once.
 */
export function stackMembers(
  chapters: ChapterDto[],
  scope: EditorScope,
  hostId: string,
  host: Pick<EditorPaneState, 'chapterGuid' | 'sceneId'>
): StackMember[] {
  if (scope === 'scene' || !host.sceneId) return []
  const included = scope === 'manuscript'
    ? chapters
    : chapters.filter((chapter) => chapter.guid === host.chapterGuid)
  return included.flatMap((chapter) =>
    chapter.scenes.map((scene, index) => ({
      chapterGuid: chapter.guid,
      chapterTitle: chapter.title,
      sceneId: scene.id,
      paneId: scene.id === host.sceneId ? hostId : stackedPaneId(hostId, scene.id),
      opensChapter: index === 0
    }))
  )
}
