import { rpc } from '../rpc/client'
import { useManuscriptStore } from './manuscriptStore'
import { useFilterStore } from './filterStore'
import { resolveWritingProjection } from './writingProjection'
import { getWritingNavigation } from '../views/editor/writingNavigation'
import type { ChapterDto } from './projectTypes'
import type { SceneRef, WritingContext } from '../views/editor/writingTypes'

export async function widenWritingRunForScene(context: WritingContext, chapters: ChapterDto[], ref: SceneRef,
  isCurrent: () => boolean = () => true): Promise<void> {
  if (ref.bookId !== context.bookId || ref.draftId !== context.draftId ||
      !chapters.some(chapter => chapter.guid === ref.chapterGuid && chapter.scenes.some(scene => scene.id === ref.sceneId))) return
  const selectedSceneIds = useManuscriptStore.getState().composed
  const filter = useFilterStore.getState().filter
  const types = selectedSceneIds !== null ? [] : [filter.character ? 'character' : null, filter.location ? 'location' : null].filter(Boolean)
  const groups = await Promise.all(types.map(type => rpc.request<{ id: string; name: string }[]>('entities/list', [type])))
  if (!isCurrent() || useManuscriptStore.getState().composed !== selectedSceneIds || useFilterStore.getState().filter !== filter) return
  const visible = resolveWritingProjection(chapters, { context, scope: 'manuscript', anchor: ref,
    selectedSceneIds, filter, entityNames: Object.fromEntries(groups.flat().map(entity => [entity.id, entity.name])) })
  if (visible.some(scene => scene.sceneId === ref.sceneId)) return
  useManuscriptStore.setState({ composed: null, filterListId: '' })
  useFilterStore.getState().clear()
}

export async function revealWritingSceneInPane(paneId: string, ref: SceneRef, context: WritingContext,
  isCurrent: () => boolean): Promise<void> {
  const point = { sceneId: ref.sceneId, offset: 0, affinity: 'after' as const }
  for (let attempt = 0; attempt < 60 && isCurrent(); attempt++) {
    const surface = getWritingNavigation(paneId)
    if (surface?.context?.workspaceId === context.workspaceId && surface.context.workspaceEpoch === context.workspaceEpoch &&
        surface.context.bookId === ref.bookId && surface.context.draftId === ref.draftId &&
        surface.reveal(ref, { anchor: point, focus: point })) return
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
}
