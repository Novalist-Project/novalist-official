import { getWritingRegistries, transferExternalWritingRegistry, type WritingDocumentRegistry } from '../../stores/writingDocuments'
import { rebindWritingHistory } from '../../stores/writingHistory'
import { useProjectStore } from '../../stores/projectStore'
import { pendingSharedWritingToken, rebasePendingWritingReplacement } from './writingSearchExternal'
import { rpc } from '../../rpc/client'
import { capturePendingWrites } from '../../stores/pendingWrites'
import { searchRefKey } from './writingSearch'
import { getSharedWritingSession, transferExternalSharedWritingSession, transferSharedWritingSession } from '../../collaboration/sharedWritingSessions'
import { decodeWritingUpdate, encodeWritingUpdate } from '../../collaboration/sharedWritingUpdates'
import type { SceneSnapshot } from './writingTypes'
import type { WritingSearchContext, WritingSearchLeaseRequest } from '../../../../shared/writingSearchProtocol'

interface LeaseOwner { registry: WritingDocumentRegistry; release(): void; documents: readonly { current: SceneSnapshot; saved: SceneSnapshot }[] }
interface Lease { owners: LeaseOwner[]; frames: { frame: HTMLIFrameElement; inert: boolean }[]; cancelled: boolean }
const leases = new Map<string, Lease>()

function releaseLease(token: string, lease: Lease): void {
  const restoreFrames = !lease.cancelled
  lease.cancelled = true
  for (const owner of lease.owners) owner.release()
  if (restoreFrames) for (const { frame, inert } of lease.frames) frame.inert = inert
  if (leases.get(token) === lease) leases.delete(token)
}

function assertPreparing(lease: Lease): void {
  if (lease.cancelled) throw new Error('The writing replacement was cancelled.')
}

export function validateWritingSearchRecovery(context: WritingSearchContext): void {
  for (const lease of leases.values()) for (const owner of lease.owners) {
    if (owner.registry.context.workspaceId !== context.workspaceId) throw new Error('Restore the previous workspace to recover its pending replacement.')
  }
}

export function rebaseWritingSearchLeases(context: WritingSearchContext): void {
  validateWritingSearchRecovery(context)
  for (const [token, lease] of leases) {
    for (const owner of lease.owners) {
      const previous = owner.registry.context
      transferExternalWritingRegistry(owner.registry, token, previous, { ...previous, workspaceEpoch: context.workspaceEpoch })
      rebindWritingHistory(owner.registry, owner.registry)
    }
    rebasePendingWritingReplacement(token, context)
  }
}

function waitForContext(context: WritingSearchContext): Promise<void> {
  const current = (): boolean => {
    const state = useProjectStore.getState()
    return state.projectPath === context.workspaceId && state.workspaceEpoch === context.workspaceEpoch
  }
  if (current()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const stop = useProjectStore.subscribe(() => {
      if (!current()) return
      clearTimeout(timer)
      stop()
      resolve()
    })
    const timer = setTimeout(() => { stop(); reject(new Error('The writing workspace has not recovered.')) }, 15_000)
  })
}

async function prepare(request: WritingSearchLeaseRequest): Promise<void> {
  if (leases.has(request.token)) return
  capturePendingWrites()
  const refs = new Set(request.refs.map(searchRefKey))
  const frames = [...document.querySelectorAll('iframe')].map(frame => ({ frame, inert: frame.inert }))
  for (const { frame } of frames) frame.inert = true
  const lease: Lease = { owners: [], frames, cancelled: false }
  leases.set(request.token, lease)
  try {
    for (const registry of getWritingRegistries(request)) {
      if (!registry.capture().some(snapshot => refs.has(searchRefKey(snapshot)))) continue
      for (const snapshot of registry.capture()) {
        if (snapshot.shared && refs.has(searchRefKey(snapshot))) {
          await getSharedWritingSession(snapshot.shared).flush()
          assertPreparing(lease)
        }
      }
      const release = await registry.reserveExternal(request.token)
      const owner: LeaseOwner = { registry, release, documents: [] }
      lease.owners.push(owner)
      assertPreparing(lease)
      owner.documents = registry.captureExternal().filter(document => refs.has(searchRefKey(document.current))).map(document => {
        const snapshot = document.current
        if (!snapshot.shared) return document
        const session = getSharedWritingSession(snapshot.shared)
        session.assertReady()
        return { ...document, current: { ...snapshot, html: session.html, revision: session.revision,
          shared: { ...snapshot.shared, state: encodeWritingUpdate(session.state()) } } }
      })
    }
  } catch (error) { releaseLease(request.token, lease); throw error }
}

async function reconnectSharedOwners(token: string): Promise<void> {
  const lease = leases.get(token)
  for (const owner of lease?.owners ?? []) for (const document of owner.documents) {
    const previous = owner.registry.getSnapshot(document.current)?.shared
    if (!previous) continue
    const ref = document.current
    const next = (await rpc.request<Pick<SceneSnapshot, 'shared'>>('scenes/readPassive', [ref.bookId, ref.draftId, ref.chapterGuid, ref.sceneId])).shared
    if (!next) throw new Error('Reconnect the shared scene before recovering the replacement.')
    const group = pendingSharedWritingToken(token, ref)
    if (group) transferExternalSharedWritingSession(group, previous, next)
    else {
      transferSharedWritingSession(previous, next)
      getSharedWritingSession(next).receive(decodeWritingUpdate(next.state))
    }
    owner.registry.acceptExternalSharedIdentity(token, ref, previous, next)
  }
}

async function receive(request: WritingSearchLeaseRequest): Promise<void> {
  try {
    if (request.stage === 'prepare') await prepare(request)
    if (request.stage === 'rebase') {
      await waitForContext(request)
      rebaseWritingSearchLeases(request)
      await reconnectSharedOwners(request.token)
    }
    const lease = leases.get(request.token)
    if (request.stage === 'commit') {
      if (!lease) throw new Error('The replacement lease is unavailable.')
      for (const owner of lease.owners) {
        const snapshots = new Map(owner.documents.map(document => [searchRefKey(document.current), document.current]))
        const changes = (request.changes ?? []).flatMap(change => {
          const before = snapshots.get(searchRefKey(change.ref))
          return before ? [{ ...change, before }] : []
        })
        owner.registry.acceptExternalCommit(request.token, changes)
      }
    }
    if (request.stage === 'release' && lease) releaseLease(request.token, lease)
    window.novalist.writingSearchLeaseAck?.({ token: request.token, stage: request.stage,
      documents: lease?.owners.flatMap(owner => [...owner.documents]) ?? [] })
  } catch {
    window.novalist.writingSearchLeaseAck?.({ token: request.token, stage: request.stage, error: 'A writing owner could not validate the replacement.' })
  }
}

export function installWritingSearchLease(): void {
  window.novalist.onWritingSearchLease?.(request => { void receive(request) })
}
