import type { PlanningStateDto } from '../../stores/planningTypes'
import type { StructureCommand } from '../editor/writingStructureTypes'

export type StructureItem = { kind: 'scenes' | 'chapters'; ids: string[] } | { kind: 'act'; name: string }
export type StructureTarget = { kind: 'scene'; chapterGuid: string; sceneId: string } |
  { kind: 'chapter'; chapterGuid: string } | { kind: 'act'; name: string | null; firstChapterGuid?: string }
export type StructurePosition = 'before' | 'after' | 'inside'

export function buildStructureMove(state: PlanningStateDto, item: StructureItem, target: StructureTarget, position: StructurePosition): StructureCommand | null {
  const chapters = [...state.chapters].sort((a, b) => a.order - b.order)
  if (item.kind === 'act') {
    if (target.kind !== 'act' || !target.name || target.name === item.name) return null
    const acts = state.acts.filter(act => act.name && act.name !== item.name)
    const index = acts.findIndex(act => act.name === target.name)
    if (index < 0) return null
    return { kind: 'moveAct', name: item.name, beforeActName: acts[index + (position === 'after' ? 1 : 0)]?.name ?? null }
  }
  if (item.kind === 'scenes') {
    if (target.kind === 'act') return null
    const chapter = chapters.find(value => value.guid === target.chapterGuid)
    if (!chapter) return null
    const ids = chapters.flatMap(value => [...value.scenes].sort((a, b) => a.order - b.order)).filter(scene => item.ids.includes(scene.id)).map(scene => scene.id)
    if (!ids.length || target.kind === 'scene' && ids.includes(target.sceneId)) return null
    const remaining = [...chapter.scenes].sort((a, b) => a.order - b.order).filter(scene => !ids.includes(scene.id))
    const index = target.kind === 'scene' ? remaining.findIndex(scene => scene.id === target.sceneId) : -1
    if (target.kind === 'scene' && index < 0) return null
    return { kind: 'moveScenes', sceneIds: ids, targetChapterGuid: chapter.guid,
      beforeSceneId: target.kind === 'scene' ? remaining[index + (position === 'after' ? 1 : 0)]?.id ?? null : null }
  }
  const ids = chapters.filter(chapter => item.ids.includes(chapter.guid)).map(chapter => chapter.guid)
  if (!ids.length || target.kind === 'scene' || target.kind === 'chapter' && ids.includes(target.chapterGuid)) return null
  const remaining = chapters.filter(chapter => !ids.includes(chapter.guid))
  if (target.kind === 'chapter') {
    const index = remaining.findIndex(chapter => chapter.guid === target.chapterGuid)
    if (index < 0) return null
    return { kind: 'moveChapters', chapterGuids: ids, targetActName: remaining[index].act || null,
      beforeChapterGuid: remaining[index + (position === 'after' ? 1 : 0)]?.guid ?? null }
  }
  const actIndex = state.acts.findIndex(act => act.name === target.name && (!target.firstChapterGuid || act.chapterGuids[0] === target.firstChapterGuid))
  if (actIndex < 0) return null
  const following = new Set(state.acts.slice(actIndex + 1).flatMap(act => act.chapterGuids))
  return { kind: 'moveChapters', chapterGuids: ids, targetActName: target.name,
    beforeChapterGuid: remaining.find(chapter => following.has(chapter.guid))?.guid ?? null }
}
