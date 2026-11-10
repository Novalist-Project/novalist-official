import type { SharedSceneIdentity } from '../../../../shared/sharedScene'
import type { ProjectFilter } from '../../stores/filterStore'

export interface SceneRef {
  bookId: string
  draftId: string
  chapterGuid: string
  sceneId: string
}

export interface WritingContext {
  readonly workspaceId: string
  readonly workspaceEpoch: number
  readonly bookId: string
  readonly draftId: string
}

export interface WritingActivation {
  sourceId: string
  focusGeneration: number
  activationGeneration: number
}

export type WritingScope = 'scene' | 'chapter' | 'manuscript'
export type WritingFilter = ProjectFilter

/** UTF-16 offsets in searchable prose, excluding editor chrome. */
export interface WritingPoint {
  sceneId: string
  offset: number
  affinity: 'before' | 'after'
}

export interface WritingSelection {
  anchor: WritingPoint
  focus: WritingPoint
}

export interface SceneSnapshot extends SceneRef {
  html: string
  hash: string
  revision: number
  shared?: SharedSceneIdentity | null
}

export interface SceneChange {
  ref: SceneRef
  expectedRevision: number
  expectedHash?: string
  beforeHtml: string
  afterHtml: string
}

export interface WritingAnnotations {
  comments: { id: string; anchorText: string; text: string; resolved: boolean }[]
  footnotes: { id: string; number: number; text: string }[]
}

export interface AnnotationChange {
  ref: SceneRef
  before: WritingAnnotations
  after: WritingAnnotations
}

export interface WritingTransaction {
  id: string
  context: WritingContext
  origin: string
  kind: 'input' | 'format' | 'replace' | 'structure'
  changes: SceneChange[]
  /** An empty change list leaves annotations untouched. */
  annotationChanges: AnnotationChange[]
  beforeSelection: WritingSelection | null
  afterSelection: WritingSelection | null
}

export interface WritingProjection {
  context: WritingContext
  scope: WritingScope
  anchor: SceneRef | null
  /** null is unrestricted; [] is an explicitly empty run. */
  selectedSceneIds: string[] | null
  filter: WritingFilter
  entityNames?: Readonly<Record<string, string>>
}

export interface WritingRegistry {
  readonly context: WritingContext
  read(ref: SceneRef): Promise<SceneSnapshot>
  capture(): readonly SceneSnapshot[]
  apply(tx: WritingTransaction): void
  subscribe(ref: SceneRef | string, listener: (snapshot: SceneSnapshot) => void): () => void
  close(): Promise<void>
}

export interface HistoryResult {
  status: 'applied' | 'blocked'
  reason?: string
  selection?: WritingSelection | null
}

export type HistoryInverse =
  | { kind: 'local'; changes: SceneChange[]; annotationChanges: AnnotationChange[] }
  | { kind: 'shared'; token: string; refs: SceneRef[] }
  | { kind: 'structure'; operationId: string; expectedRevision: number }

export interface WritingHistory {
  record(tx: WritingTransaction, inverse: HistoryInverse): void
  undo(): Promise<HistoryResult>
  redo(): Promise<HistoryResult>
}

export interface WritingCommitRequest {
  transactionId: string
  expectedEpoch: number
  changes: SceneChange[]
  annotationChanges: AnnotationChange[]
}

export interface SceneHash {
  ref: SceneRef
  hash: string
}

export type WritingCommitResult =
  | { status: 'committed'; operationId: string; hashes: SceneHash[] }
  | { status: 'conflict'; conflicts: SceneHash[] }
  | { status: 'retryable'; operationId: string; errorCode: string }
