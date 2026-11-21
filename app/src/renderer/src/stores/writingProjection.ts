import type { ChapterDto, SceneDto } from './projectTypes'
import type { SceneRef, WritingProjection } from '../views/editor/writingTypes'

type ProjectionScene = Pick<SceneDto, 'id' | 'order' | 'stage' | 'plotlineIds'> & {
  cast?: readonly string[]
  pov?: string | null
}
type ProjectionChapter = Pick<ChapterDto, 'guid' | 'order' | 'status'> & { scenes: readonly ProjectionScene[] }

function namesEntity(scene: ProjectionScene, id: string, names: WritingProjection['entityNames']): boolean {
  if (!id) return true
  if (scene.cast?.includes(id)) return true
  const name = names?.[id]
  return !!name && !!scene.pov && scene.pov.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0
}

function passes(scene: ProjectionScene, projection: WritingProjection): boolean {
  const { filter, entityNames } = projection
  return (!filter.stage || (scene.stage ?? '').toLowerCase() === filter.stage.toLowerCase()) &&
    (!filter.plotline || scene.plotlineIds.includes(filter.plotline)) &&
    namesEntity(scene, filter.character, entityNames) && namesEntity(scene, filter.location, entityNames)
}

export function resolveWritingProjection(chapters: readonly ProjectionChapter[], projection: WritingProjection): SceneRef[] {
  const { context, anchor, scope, selectedSceneIds, filter } = projection
  if (anchor && (anchor.bookId !== context.bookId || anchor.draftId !== context.draftId)) return []
  if (scope !== 'manuscript' && !anchor) return []
  const selected = selectedSceneIds === null ? null : new Set(selectedSceneIds)
  return [...chapters].sort((a, b) => a.order - b.order).flatMap(chapter => {
    if (scope !== 'manuscript' && chapter.guid !== anchor?.chapterGuid) return []
    if (!selected && filter.status && filter.status !== 'All' && chapter.status.toLowerCase() !== filter.status.toLowerCase()) return []
    return [...chapter.scenes].sort((a, b) => a.order - b.order).flatMap(scene => {
      if (scope === 'scene' && scene.id !== anchor?.sceneId) return []
      if (selected ? !selected.has(scene.id) : !passes(scene, projection)) return []
      return [{ bookId: context.bookId, draftId: context.draftId, chapterGuid: chapter.guid, sceneId: scene.id }]
    })
  })
}
