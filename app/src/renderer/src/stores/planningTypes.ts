import type { ChapterDto, SceneDto } from './projectTypes'
import type { ManuscriptSceneDto, ManuscriptSectionDto } from './manuscriptTypes'

export type PlanningSceneCard = Omit<ManuscriptSceneDto, 'html' | 'hash' | 'shared'>
export type PlanningSection = Omit<ManuscriptSectionDto, 'scenes'> & { scenes: PlanningSceneCard[] }

export interface PlanningScene extends SceneDto {
  pov: string | null
  goal: string | null
  outcome: string | null
  properties: Record<string, string>
}

export interface PlanningChapter extends Omit<ChapterDto, 'scenes'> {
  scenes: PlanningScene[]
}

export interface PlanningAct {
  name: string | null
  chapterGuids: string[]
  metadata: {
    name: string
    wordTarget?: number | null
    dateRange?: { start: string; end: string; note: string; startTime: string; endTime: string } | null
  } | null
}

export interface PlanningStateDto {
  bookId: string
  draftId: string
  structureRevision: string
  acts: PlanningAct[]
  issues: { code: string; actName: string | null }[]
  chapters: PlanningChapter[]
}
