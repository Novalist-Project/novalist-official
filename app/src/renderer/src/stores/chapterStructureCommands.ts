import type { ChapterDateRange, ChapterDto } from './projectTypes'
import type { PlanningAct } from './planningTypes'
import type { StructureCommand } from '../views/editor/writingStructureTypes'

const ordered = (chapters: ChapterDto[]): ChapterDto[] => [...chapters].sort((a, b) => a.order - b.order)
const sameAct = (left: string, right: string): boolean => left.toLocaleLowerCase() === right.toLocaleLowerCase()

function actBoundary(chapters: ChapterDto[], act: string, acts: readonly PlanningAct[]): string | null {
  const last = chapters.findLastIndex(chapter => sameAct(chapter.act, act))
  if (last >= 0) return chapters[last + 1]?.guid ?? null
  const index = acts.findIndex(value => value.name !== null && sameAct(value.name, act))
  if (index < 0) return null
  const following = new Set(acts.slice(index + 1).flatMap(value => value.chapterGuids))
  return chapters.find(chapter => following.has(chapter.guid))?.guid ?? null
}

export function reorderChapterCommand(chapters: ChapterDto[], guid: string, order: number): StructureCommand {
  const full = ordered(chapters)
  const index = full.findIndex(chapter => chapter.order === order)
  if (index < 0 || !full.some(chapter => chapter.guid === guid)) throw new Error('writing.structureConflict')
  const remaining = full.filter(chapter => chapter.guid !== guid)
  return { kind: 'moveChapters', chapterGuids: [guid], beforeChapterGuid: remaining[index]?.guid ?? null, targetActName: full[index].act || null }
}

export function chapterActCommand(chapters: ChapterDto[], guid: string, act: string, acts: readonly PlanningAct[] = []): StructureCommand {
  const full = ordered(chapters)
  const chapter = full.find(value => value.guid === guid)
  if (!chapter) throw new Error('writing.structureConflict')
  const remaining = full.filter(value => value.guid !== guid)
  return { kind: 'moveChapters', chapterGuids: [guid], beforeChapterGuid: actBoundary(remaining, act || chapter.act, acts), targetActName: act || null }
}

export function insertChapterCommand(chapters: ChapterDto[], title: string, order?: number, act?: string, acts: readonly PlanningAct[] = [], dateRange?: ChapterDateRange): StructureCommand {
  const full = ordered(chapters)
  const index = order === undefined ? full.length : full.findIndex(chapter => chapter.order >= order)
  const at = index < 0 ? full.length : index
  const inherited = full[at - 1]?.act ?? full[at]?.act ?? ''
  const before = act === undefined ? full[at]?.guid ?? null : act ? actBoundary(full, act, acts) : null
  return { kind: 'insertChapter', title, beforeChapterGuid: before, actName: (act ?? inherited) || null, ...(dateRange ? { dateRange } : {}) }
}
