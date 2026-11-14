import { randomUUID } from 'node:crypto'
import type { WritingSearchContext, WritingSearchLease, WritingSearchLeaseReply, WritingSearchLeaseRequest, WritingSearchSharedIntent } from '../shared/writingSearchProtocol'
import type { WritingPublicationDetails } from './writing-search-publication'
import type { SceneRef, WritingCommitRequest, WritingCommitResult } from '../renderer/src/views/editor/writingTypes'

interface Publication {
  context: WritingSearchContext
  shared?: WritingSearchSharedIntent
  requester: number
  token: string
  request: WritingCommitRequest
  after: { ref: SceneRef; afterHtml: string }[]
  result?: WritingCommitResult
  inFlight?: Promise<WritingCommitResult>
  complete?: boolean
}

function referenceKey(ref: SceneRef): string { return JSON.stringify([ref.bookId, ref.draftId, ref.chapterGuid, ref.sceneId]) }

export class WritingSearchLeaseBroker {
  private readonly owners = new Map<number, (request: WritingSearchLeaseRequest) => void>()
  private lease: { requester: number; request: WritingSearchLeaseRequest; participants: Set<number> } | null = null
  private pending: { remaining: Set<number>; results: WritingSearchLease['owners']; resolve(value: WritingSearchLease): void;
    reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | null = null
  private readonly publications = new Map<string, Publication>()
  private recovery: Promise<void> | null = null
  private readonly commit?: (request: WritingCommitRequest, details: WritingPublicationDetails) => Promise<WritingCommitResult>
  private readonly report: (error: unknown) => void

  constructor(commit?: (request: WritingCommitRequest, details: WritingPublicationDetails) => Promise<WritingCommitResult>,
    report: (error: unknown) => void = error => { console.error('Writing lease recovery failed.', error instanceof Error ? error.name : 'Error') }) {
    this.commit = commit
    this.report = report
  }

  get hasLease(): boolean { return this.lease !== null }

  recover(context: WritingSearchContext): Promise<void> {
    if (this.recovery) return this.recovery
    const recovery = this.recoverLease(context)
    this.recovery = recovery
    void recovery.finally(() => { this.recovery = null }).catch(() => {})
    return recovery
  }

  private async recoverLease(context: WritingSearchContext): Promise<void> {
    const lease = this.lease
    if (!lease) return
    if (lease.request.workspaceId !== context.workspaceId) throw new Error('The replacement belongs to the previous workspace.')
    const publication = this.publications.get(lease.request.token)
    if (publication?.inFlight) {
      try { await publication.inFlight }
      catch { /* The durable receipt remains authoritative after a lost backend reply. */ }
    }
    if (this.lease !== lease) return
    lease.request = { ...lease.request, ...context, stage: 'rebase' }
    await this.send()
    if (!publication) { await this.finish(lease.requester, lease.request.token); return }
    publication.context = context
    publication.request.expectedEpoch = context.workspaceEpoch
    publication.inFlight = undefined
    await this.publish(publication.requester, publication.token, publication.request, publication.after, publication.shared)
  }

  register(owner: number, send: (request: WritingSearchLeaseRequest) => void): void { this.owners.set(owner, send) }
  remove(owner: number): void {
    this.owners.delete(owner)
    if (!this.lease?.participants.has(owner)) return
    const lease = this.lease
    const publication = this.publications.get(lease.request.token)
    lease.participants.delete(owner)
    if (!publication && this.pending) { this.fail('A participating writing window closed.'); return }
    this.acknowledge(owner, { token: lease.request.token, stage: lease.request.stage, documents: [] })
    if (owner === lease.requester && !publication) void this.finish(owner, lease.request.token).catch(this.report)
  }

  async acquire(requester: number, context: WritingSearchContext, refs: SceneRef[]): Promise<WritingSearchLease> {
    if (this.lease) throw new Error('Another writing replacement is still pending.')
    this.lease = { requester, request: { ...context, refs, token: randomUUID(), stage: 'prepare' }, participants: new Set(this.owners.keys()) }
    try { return await this.send() }
    catch (error) {
      await this.finish(requester, this.lease.request.token)
      throw error
    }
  }

  async finish(requester: number, token: string, changes?: WritingSearchLeaseRequest['changes']): Promise<void> {
    if (!this.lease || this.lease.requester !== requester || this.lease.request.token !== token) throw new Error('The writing lease is unavailable.')
    this.lease.request = { ...this.lease.request, stage: changes ? 'commit' : 'release', changes }
    await this.send()
    if (!changes) this.lease = null
  }

  publish(requester: number, token: string, request: WritingCommitRequest,
    after: Publication['after'], shared?: WritingSearchSharedIntent): Promise<WritingCommitResult> {
    let publication = this.publications.get(token)
    if (publication && (publication.requester !== requester || JSON.stringify(publication.request) !== JSON.stringify(request)
      || JSON.stringify(publication.after) !== JSON.stringify(after) || JSON.stringify(publication.shared) !== JSON.stringify(shared))) {
      return Promise.reject(new Error('The replacement publication receipt does not match.'))
    }
    if (!publication) {
      if (!this.lease || this.lease.requester !== requester || this.lease.request.token !== token) return Promise.reject(new Error('The writing lease is unavailable.'))
      const allowed = new Set(this.lease.request.refs.map(referenceKey))
      const outputs = new Map(after.map(change => [referenceKey(change.ref), change.afterHtml]))
      if (request.expectedEpoch !== this.lease.request.workspaceEpoch || request.annotationChanges.length
        || request.changes.length !== outputs.size || after.length !== outputs.size
        || request.changes.some(change => !allowed.has(referenceKey(change.ref)) || outputs.get(referenceKey(change.ref)) !== change.afterHtml)) {
        return Promise.reject(new Error('The publication must match the reserved writing changes.'))
      }
      if (shared?.changes.some(change => !allowed.has(referenceKey(change.ref)))) return Promise.reject(new Error('Shared changes must belong to the writing lease.'))
      publication = { requester, token, context: { workspaceId: this.lease.request.workspaceId, workspaceEpoch: this.lease.request.workspaceEpoch },
        request: structuredClone(request), after: structuredClone(after), shared: structuredClone(shared) }
      this.publications.set(token, publication)
    }
    if (publication.complete) return Promise.resolve(publication.result!)
    if (publication.inFlight) return publication.inFlight
    const operation = this.publishReceipt(publication)
    publication.inFlight = operation
    void operation.finally(() => { publication.inFlight = undefined }).catch(() => {})
    return operation
  }

  private async publishReceipt(publication: Publication): Promise<WritingCommitResult> {
    if (!this.commit) throw new Error('The writing publication transport is unavailable.')
    const result = publication.result?.status === 'committed' ? publication.result : await this.commit(publication.request,
      { token: publication.token, context: publication.context, shared: publication.shared })
    publication.result = result
    if (result.status === 'retryable') return result
    if (result.status === 'committed') {
      const hashes = new Map(result.hashes.map(entry => [referenceKey(entry.ref), entry.hash]))
      const changes = publication.after.map(change => {
        const hash = hashes.get(referenceKey(change.ref))
        if (!hash) throw new Error('The writing publication acknowledgement is incomplete.')
        return { ...change, hash }
      })
      await this.finish(publication.requester, publication.token, changes)
    }
    await this.finish(publication.requester, publication.token)
    publication.complete = true
    for (const [token, receipt] of this.publications) {
      if (this.publications.size <= 32) break
      if (receipt.complete && receipt !== publication) this.publications.delete(token)
    }
    return result
  }

  acknowledge(owner: number, reply: WritingSearchLeaseReply): void {
    if (!this.lease || reply.token !== this.lease.request.token || reply.stage !== this.lease.request.stage || !this.pending?.remaining.has(owner)) return
    if (reply.error) { this.fail(reply.error); return }
    this.pending.remaining.delete(owner)
    this.pending.results.push({ owner, documents: reply.documents ?? [] })
    if (this.pending.remaining.size) return
    const pending = this.pending
    this.pending = null
    clearTimeout(pending.timer)
    const requester = this.lease.requester
    pending.resolve({ token: reply.token, owners: pending.results.sort((a, b) => Number(b.owner === requester) - Number(a.owner === requester)) })
  }

  private send(): Promise<WritingSearchLease> {
    if (this.pending) return Promise.reject(new Error('Writing replacement is still waiting for its owners.'))
    return new Promise((resolve, reject) => {
      const lease = this.lease!
      if (!lease.participants.size && lease.request.stage !== 'prepare') { resolve({ token: lease.request.token, owners: [] }); return }
      this.pending = { remaining: new Set(lease.participants), results: [], resolve, reject,
        timer: setTimeout(() => this.fail('A writing owner did not acknowledge the replacement.'), 15_000) }
      for (const owner of lease.participants) {
        const send = this.owners.get(owner)
        if (!send) { this.fail('A writing owner is unavailable.'); return }
        send(lease.request)
      }
      if (!lease.participants.size) this.fail('No writing owners are ready.')
    })
  }

  private fail(message: string): void {
    if (!this.pending) return
    const pending = this.pending
    this.pending = null
    clearTimeout(pending.timer)
    pending.reject(new Error(message))
  }
}
