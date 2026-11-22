import type { ProjectFilter } from '../../stores/filterStore'
import type { PlanningAct, PlanningChapter, PlanningScene, PlanningSection, PlanningStateDto } from '../../stores/planningTypes'
import { resolveWritingProjection } from '../../stores/writingProjection'

export type StructureRow =
  | { kind: 'act'; key: string; act: PlanningAct }
  | { kind: 'chapter'; key: string; chapter: PlanningChapter; actKey: string }
  | { kind: 'scene'; key: string; scene: PlanningScene; chapter: PlanningChapter; actKey: string }

export interface StructureRowOptions {
  selectedSceneIds?: string[] | null
  entityNames?: Readonly<Record<string, string>>
  collapsed?: ReadonlySet<string>
}

export function buildPlanningSections(state: PlanningStateDto, filter: ProjectFilter, options: StructureRowOptions = {}): PlanningSection[] {
  const rows = buildStructureRows(state, filter, { ...options, collapsed: undefined })
  const sections = new Map<string, PlanningSection>()
  for (const row of rows) {
    if (row.kind === 'chapter') sections.set(row.chapter.guid, {
      chapterGuid: row.chapter.guid, chapterTitle: row.chapter.title, status: row.chapter.status, act: row.chapter.act, scenes: []
    })
    if (row.kind === 'scene') sections.get(row.chapter.guid)!.scenes.push({
      sceneId: row.scene.id, title: row.scene.title, wordCount: row.scene.wordCount, synopsis: row.scene.synopsis,
      pov: row.scene.pov, goal: row.scene.goal, outcome: row.scene.outcome, inactive: row.scene.inactive
    })
  }
  return [...sections.values()]
}

export function buildStructureRows(state: PlanningStateDto, filter: ProjectFilter, options: StructureRowOptions = {}): StructureRow[] {
  const visible = new Set(resolveWritingProjection(state.chapters, {
    context: { workspaceId: '', workspaceEpoch: 0, bookId: state.bookId, draftId: state.draftId },
    scope: 'manuscript', anchor: null, filter, entityNames: options.entityNames,
    selectedSceneIds: options.selectedSceneIds ?? null
  }).map(ref => ref.sceneId))
  const chapters = new Map(state.chapters.map(chapter => [chapter.guid, chapter]))
  const rows: StructureRow[] = []
  for (const act of state.acts) {
    const actKey = `act:${act.name ?? ''}:${act.chapterGuids[0] ?? 'empty'}`
    const children = act.chapterGuids.map(id => chapters.get(id)).filter((chapter): chapter is PlanningChapter => !!chapter)
      .filter(chapter => chapter.scenes.length === 0 || chapter.scenes.some(scene => visible.has(scene.id)))
    if (act.chapterGuids.length && children.length === 0) continue
    rows.push({ kind: 'act', key: actKey, act })
    if (options.collapsed?.has(actKey)) continue
    for (const chapter of children) {
      const key = `chapter:${chapter.guid}`
      rows.push({ kind: 'chapter', key, chapter, actKey })
      if (options.collapsed?.has(key)) continue
      for (const scene of [...chapter.scenes].sort((a, b) => a.order - b.order)) {
        if (visible.has(scene.id)) rows.push({ kind: 'scene', key: `scene:${scene.id}`, scene, chapter, actKey })
      }
    }
  }
  return rows
}
