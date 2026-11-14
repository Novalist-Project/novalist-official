import type { SceneRef, SceneSnapshot } from '../renderer/src/views/editor/writingTypes'

export interface WritingSearchContext { workspaceId: string; workspaceEpoch: number }
export interface WritingSearchCapture {
  owner: number
  snapshots: (SceneSnapshot & { dirty?: boolean })[]
}
export interface WritingSearchCaptureRequest extends WritingSearchContext { token: string }
export interface WritingSearchCaptureReply { token: string; snapshots?: WritingSearchCapture['snapshots']; error?: string }

export interface WritingSearchLeaseRequest extends WritingSearchContext {
  token: string
  stage: 'prepare' | 'commit' | 'release' | 'rebase'
  refs: SceneRef[]
  changes?: { ref: SceneRef; afterHtml: string; hash: string }[]
}
export interface WritingSearchLeaseReply {
  token: string
  stage: WritingSearchLeaseRequest['stage']
  documents?: { current: SceneSnapshot; saved: SceneSnapshot }[]
  error?: string
}
export interface WritingSearchLease {
  token: string
  owners: { owner: number; documents: NonNullable<WritingSearchLeaseReply['documents']> }[]
}

export interface WritingSearchSharedIntent {
  groupId: string
  changes: { ref: SceneRef; sessionId: string; itemId: string; sourceState: string;
    forwardUpdate: string; inverseUpdate: string; beforeHtml: string; afterHtml: string }[]
}
