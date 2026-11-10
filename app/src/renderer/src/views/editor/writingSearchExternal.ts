import { rpc } from '../../rpc/client'
import { useProjectStore } from '../../stores/projectStore'
import { recordExternalWritingTransaction } from '../../stores/writingHistory'
import { prepareSharedWritingGroup, type PreparedSharedWritingGroup } from '../../collaboration/sharedWritingGroup'
import { getSharedWritingSession } from '../../collaboration/sharedWritingSessions'
import { captureSearchOverrides, searchRefKey } from './writingSearch'
import type { WritingMatch, WritingSearchResult } from './writingSearch'
import type { HistoryResult, SceneChange, SceneRef, WritingCommitRequest, WritingContext } from './writingTypes'
import type { WritingSearchLease } from '../../../../shared/writingSearchProtocol'

interface ReplacementReceipt {
  action: 'replace' | 'undo' | 'redo'
  historyId: string
  count: number
  context: WritingContext
  lease: WritingSearchLease
  request: WritingCommitRequest
  changes: SceneChange[]
  shared?: PreparedSharedWritingGroup
}
let pending: ReplacementReceipt | null = null

export function hasPendingWritingReplacement(): boolean { return pending?.action === 'replace' }

export function rebasePendingWritingReplacement(token: string, context: Pick<WritingContext, 'workspaceId' | 'workspaceEpoch'>): void {
  if (pending?.lease.token !== token) return
  if (pending.context.workspaceId !== context.workspaceId) throw new Error('The replacement belongs to another workspace.')
  pending.context = { ...pending.context, workspaceEpoch: context.workspaceEpoch }
  pending.request.expectedEpoch = context.workspaceEpoch
}

export function pendingSharedWritingToken(token: string, ref: SceneRef): string | undefined {
  if (pending?.lease.token !== token) return undefined
  const intent = pending.shared?.intent
  return intent?.changes.some(change => searchRefKey(change.ref) === searchRefKey(ref)) ? intent.groupId : undefined
}

function desktop() {
  const { acquireWritingSearchLease, finishWritingSearchLease, publishWritingSearchLease } = window.novalist
  if (!acquireWritingSearchLease || !finishWritingSearchLease || !publishWritingSearchLease) throw new Error('Desktop writing ownership is unavailable.')
  return { acquire: acquireWritingSearchLease, finish: finishWritingSearchLease, publish: publishWritingSearchLease }
}

export function externalCommitChanges(lease: WritingSearchLease, changes: SceneChange[]): SceneChange[] {
  return changes.map(change => {
    const documents = lease.owners.flatMap(owner => owner.documents).filter(document => searchRefKey(document.current) === searchRefKey(change.ref))
    if (!documents.length || documents.some(document => document.current.shared)) throw new Error('The local writing owner is unavailable.')
    const saved = documents[0].saved
    if (documents.some(document => document.saved.html !== saved.html || document.saved.hash !== saved.hash)) throw new Error('The writing owners disagree about the saved scene.')
    return { ...change, beforeHtml: saved.html, expectedHash: saved.hash, expectedRevision: saved.revision }
  })
}

async function publish(receipt: ReplacementReceipt): Promise<void> {
  const result = await desktop().publish(receipt.lease.token, receipt.request,
    receipt.changes.map(change => ({ ref: change.ref, afterHtml: change.afterHtml })), receipt.shared?.intent)
  if (result.status === 'conflict') {
    receipt.shared?.markRolledBack()
    receipt.shared?.release()
    pending = null
    throw new Error('The scene changed outside Novalist. Search again before replacing.')
  }
  if (result.status !== 'committed') throw new Error('The replacement is retained. Retry Replace to finish saving it.')
  receipt.shared?.markPublished()
  receipt.shared?.release()
  pending = null
}

async function ensureOwners(context: WritingContext, refs: SceneRef[], captured: WritingSearchResult['request']['overrides']): Promise<void> {
  const known = new Set(captured.map(snapshot => searchRefKey(snapshot.ref)))
  for (const ref of refs) {
    if (known.has(searchRefKey(ref))) continue
    const registry = useProjectStore.getState().getWritingRegistry({ ...context, bookId: ref.bookId, draftId: ref.draftId })
    if (!registry) throw new Error('The writing owner is unavailable.')
    await registry.read(ref)
  }
}

function captures(lease: WritingSearchLease) {
  return lease.owners.map(owner => ({ owner: owner.owner, snapshots: owner.documents.map(document => ({ ...document.current, dirty: document.current.html !== document.saved.html })) }))
}

async function replay(context: WritingContext, original: SceneChange[], shared: PreparedSharedWritingGroup | undefined, historyId: string, redo: boolean): Promise<HistoryResult> {
  try {
    if (pending) {
      if (pending.historyId !== historyId || pending.action !== (redo ? 'redo' : 'undo')) return { status: 'blocked', reason: 'writing.historyConflict' }
      await publish(pending)
      return { status: 'applied' }
    }
    const refs = [...original.map(change => change.ref), ...shared?.intent.changes.map(change => change.ref) ?? []]
    const lease = await desktop().acquire(context, refs)
    try {
      const snapshots = captureSearchOverrides(refs, captures(lease))
      const current = new Map(snapshots.map(snapshot => [searchRefKey(snapshot.ref), snapshot]))
      const changes = original.map(change => {
        const snapshot = current.get(searchRefKey(change.ref))
        if (!snapshot || snapshot.html !== (redo ? change.beforeHtml : change.afterHtml)) throw new Error('The replacement changed since this history entry.')
        return { ref: change.ref, beforeHtml: snapshot.html, afterHtml: redo ? change.afterHtml : change.beforeHtml,
          expectedRevision: snapshot.revision, expectedHash: snapshot.hash }
      })
      if (shared) await (redo ? shared.prepareRedo() : shared.prepareUndo())
      pending = { context, lease, changes, shared, historyId, action: redo ? 'redo' : 'undo', count: 0, request: { transactionId: crypto.randomUUID(), expectedEpoch: context.workspaceEpoch,
        changes: externalCommitChanges(lease, changes), annotationChanges: [] } }
    } catch (error) { await desktop().finish(lease.token); throw error }
    await publish(pending)
    return { status: 'applied' }
  } catch { return { status: 'blocked', reason: 'writing.historyConflict' } }
}

export async function replaceWritingAcrossWindows(context: WritingContext, result: WritingSearchResult,
  matches: WritingMatch[], replacement: string): Promise<number> {
  if (!pending) {
    const refs = [...new Map(matches.map(match => [searchRefKey(match.ref), match.ref])).values()]
    await ensureOwners(context, refs, result.request.overrides)
    const lease = await desktop().acquire(context, refs)
    let shared: PreparedSharedWritingGroup | undefined
    try {
      const request = { ...result.request, targets: refs, overrides: captureSearchOverrides(refs, captures(lease)) }
      const prepared = await rpc.request<SceneChange[]>('writingSearch/prepareReplace', [request, matches, replacement])
      const snapshots = new Map(lease.owners.flatMap(owner => owner.documents).map(document => [searchRefKey(document.current), document.current]))
      const sharedChanges = prepared.flatMap(change => {
        const identity = snapshots.get(searchRefKey(change.ref))?.shared
        if (!identity) return []
        const session = getSharedWritingSession(identity)
        if (session.html !== change.beforeHtml) throw new Error('The shared search result changed.')
        return [{ ...change, identity, session, expectedRevision: session.revision }]
      })
      if (sharedChanges.length) shared = await prepareSharedWritingGroup(crypto.randomUUID(), sharedChanges)
      const changes = prepared.filter(change => !snapshots.get(searchRefKey(change.ref))?.shared)
      const historyId = crypto.randomUUID()
      pending = { context, lease, changes, shared, historyId, action: 'replace', count: matches.length, request: { transactionId: historyId, expectedEpoch: context.workspaceEpoch,
        changes: externalCommitChanges(lease, changes), annotationChanges: [] } }
    } catch (error) { shared?.dispose(); await desktop().finish(lease.token); throw error }
  }
  return retryWritingReplacement()
}

export async function retryWritingReplacement(): Promise<number> {
  const receipt = pending
  if (!receipt || receipt.action !== 'replace') throw new Error('No replacement is waiting for a retry.')
  if (!useProjectStore.getState().getWritingRegistry(receipt.context)) throw new Error('The replacement history owner is unavailable.')
  await publish(receipt)
  const { context } = receipt
  const owner = useProjectStore.getState().getWritingRegistry(context)
  if (!owner) throw new Error('The replacement history owner is unavailable.')
  const currentContext = (): WritingContext => {
    const state = useProjectStore.getState()
    if (state.projectPath !== context.workspaceId) throw new Error('The replacement belongs to another workspace.')
    return { ...context, workspaceEpoch: state.workspaceEpoch }
  }
  recordExternalWritingTransaction(owner, { id: receipt.request.transactionId, context, origin: 'find-replace', kind: 'replace',
    changes: receipt.changes, annotationChanges: [], beforeSelection: null, afterSelection: null }, {
    refs: [...receipt.changes.map(change => change.ref), ...receipt.shared?.intent.changes.map(change => change.ref) ?? []],
    undo: () => replay(currentContext(), receipt.changes, receipt.shared, receipt.historyId, false), redo: () => replay(currentContext(), receipt.changes, receipt.shared, receipt.historyId, true),
    dispose: () => receipt.shared?.dispose()
  })
  return receipt.count
}
