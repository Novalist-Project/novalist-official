import type { SceneChange, SceneRef, SceneSnapshot, WritingSelection } from './writingTypes'
import type { WritingSearchCapture } from '../../../../shared/writingSearchProtocol'

export interface WritingFindOptions {
  pattern: string
  matchCase: boolean
  wholeWord: boolean
  useRegex: boolean
  includeSceneNotes?: boolean
  includeCodex?: boolean
}
export interface WritingMatch {
  ref: SceneRef
  field: string
  index: number
  length: number
  hash: string
  revision: number
  before: string
  matchedText: string
  after: string
}
export interface WritingSearchTarget { ref: SceneRef; bookTitle: string; chapterTitle: string; sceneTitle: string }
export interface WritingSearchRequest {
  options: WritingFindOptions
  targets: SceneRef[]
  overrides: { ref: SceneRef; html: string; hash: string; revision: number }[]
  expectedEpoch: number
}
export interface WritingSearchResult {
  request: WritingSearchRequest
  targets: WritingSearchTarget[]
  matches: WritingMatch[]
}

export function searchRefKey(ref: SceneRef): string {
  return JSON.stringify([ref.bookId, ref.draftId, ref.chapterGuid, ref.sceneId])
}

export function captureSearchOverrides(targets: readonly SceneRef[], captures: readonly WritingSearchCapture[]): WritingSearchRequest['overrides'] {
  const allowed = new Set(targets.map(searchRefKey))
  const snapshots = new Map<string, WritingSearchCapture['snapshots'][number]>()
  for (const capture of captures) for (const snapshot of capture.snapshots) {
    const key = searchRefKey(snapshot)
    if (!allowed.has(key)) continue
    const previous = snapshots.get(key)
    const sameShared = previous?.shared && snapshot.shared && previous.shared.sessionId === snapshot.shared.sessionId && previous.shared.itemId === snapshot.shared.itemId
    if (previous && ((!sameShared && previous.hash !== snapshot.hash) || (previous.html !== snapshot.html && previous.dirty === snapshot.dirty))) {
      throw new Error('This scene has conflicting content in another window. Resolve it before searching.')
    }
    if (!previous || (!previous.dirty && snapshot.dirty)) snapshots.set(key, snapshot)
  }
  return [...snapshots.values()].map(snapshot => ({ ref: { bookId: snapshot.bookId, draftId: snapshot.draftId,
    chapterGuid: snapshot.chapterGuid, sceneId: snapshot.sceneId }, html: snapshot.html, hash: snapshot.hash, revision: snapshot.revision }))
}

export function matchSelection(match: WritingMatch): WritingSelection {
  return { anchor: { sceneId: match.ref.sceneId, offset: match.index, affinity: 'after' },
    focus: { sceneId: match.ref.sceneId, offset: match.index + match.length, affinity: 'before' } }
}

export function validateSearchChanges(changes: readonly SceneChange[], snapshots: readonly SceneSnapshot[]): void {
  const current = new Map(snapshots.map(snapshot => [searchRefKey(snapshot), snapshot]))
  for (const change of changes) {
    const snapshot = current.get(searchRefKey(change.ref))
    if (!snapshot || snapshot.html !== change.beforeHtml || snapshot.revision !== change.expectedRevision || snapshot.hash !== change.expectedHash) {
      throw new Error('The search result changed. Search again before replacing.')
    }
  }
}
