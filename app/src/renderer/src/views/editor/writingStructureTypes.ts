import type { SceneHash, SceneRef } from './writingTypes'
import type { ChapterDateRange, ProjectStateDto } from '../../stores/projectTypes'
import type { SharedSplitPayload } from '../../collaboration/sharedWritingStructure'

type SplitProse = { ref: SceneRef; beforeHtml: string; afterHtml: string; sourceHtml: string; expectedHash: string; sharedSplit?: SharedSplitPayload }
export type StructureCommand =
  | ({ kind: 'splitScene' } & SplitProse)
  | ({ kind: 'splitChapter'; title: string } & SplitProse)
  | { kind: 'insertChapter'; title: string; beforeChapterGuid: string | null; actName: string | null; dateRange?: ChapterDateRange }
  | { kind: 'insertScene'; chapterGuid: string; title: string; beforeSceneId: string | null }
  | { kind: 'moveScenes'; sceneIds: string[]; targetChapterGuid: string; beforeSceneId: string | null }
  | { kind: 'moveChapters'; chapterGuids: string[]; beforeChapterGuid: string | null; targetActName: string | null }
  | { kind: 'createAct'; name: string; beforeActName: string | null }
  | { kind: 'renameAct'; oldName: string; newName: string }
  | { kind: 'removeAct'; name: string }
  | { kind: 'moveAct'; name: string; beforeActName: string | null }
  | { kind: 'regroupActs'; previewToken: string; expectedStructureRevision: string }

export interface StructureRequest {
  transactionId: string
  expectedEpoch: number
  bookId: string
  draftId: string
  command: StructureCommand
}

export type StructureResult = {
  status: 'committed'
  operationId: string
  state: ProjectStateDto
  hashes: SceneHash[]
  focusScene: SceneRef | null
} | { status: 'conflict' | 'retryable'; operationId: string; errorCode: string }

export interface ActRegroupPreview {
  bookId: string
  draftId: string
  revisionToken: string
  beforeChapterGuids: string[]
  afterChapterGuids: string[]
}
