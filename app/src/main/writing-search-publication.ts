import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { WritingCommitRequest, WritingCommitResult } from '../renderer/src/views/editor/writingTypes'
import type { WritingSearchContext, WritingSearchSharedIntent } from '../shared/writingSearchProtocol'
import type { SharedSceneIdentity } from '../shared/sharedScene'

export interface WritingPublicationDetails {
  token: string
  context: WritingSearchContext
  shared?: WritingSearchSharedIntent
}
interface Receipt extends WritingPublicationDetails {
  request: WritingCommitRequest
  phase: 'prepared' | 'shared' | 'compensating' | 'complete'
  result?: WritingCommitResult
}
type Request = <T>(method: string, params: unknown[]) => Promise<T>

export class WritingSearchPublicationStore {
  private readonly directory: string
  private readonly request: Request
  private recovery: Promise<void> | null = null
  constructor(directory: string, request: Request) { this.directory = directory; this.request = request }

  private path(token: string): string { return join(this.directory, createHash('sha256').update(token).digest('hex') + '.json') }

  private async save(receipt: Receipt): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const target = this.path(receipt.token)
    const temporary = target + '.tmp'
    const handle = await open(temporary, 'w', 0o600)
    try { await handle.writeFile(JSON.stringify(receipt), 'utf8'); await handle.sync() }
    finally { await handle.close() }
    await rename(temporary, target)
  }

  private async read(token: string): Promise<Receipt | null> {
    try { return JSON.parse(await readFile(this.path(token), 'utf8')) as Receipt }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }

  async publish(request: WritingCommitRequest, details: WritingPublicationDetails): Promise<WritingCommitResult> {
    let receipt = await this.read(details.token)
    if (receipt && (receipt.context.workspaceId !== details.context.workspaceId
      || JSON.stringify({ ...receipt.request, expectedEpoch: request.expectedEpoch }) !== JSON.stringify(request)
      || JSON.stringify(receipt.shared) !== JSON.stringify(details.shared))) {
      throw new Error('The durable writing publication does not match its retry.')
    }
    if (!receipt) {
      receipt = { ...structuredClone(details), request: structuredClone(request), phase: 'prepared' }
      await this.save(receipt)
    } else if (receipt.context.workspaceEpoch !== details.context.workspaceEpoch) {
      receipt.context = details.context
      receipt.request.expectedEpoch = request.expectedEpoch
      await this.save(receipt)
    }
    return this.run(receipt)
  }

  private async publishShared(receipt: Receipt, inverse: boolean): Promise<void> {
    for (const change of receipt.shared?.changes ?? []) {
      const ref = change.ref
      const scene = await this.request<{ shared?: SharedSceneIdentity }>('scenes/readPassive', [ref.bookId, ref.draftId, ref.chapterGuid, ref.sceneId])
      if (!scene.shared || scene.shared.itemId !== change.itemId) throw new Error('Reconnect the shared scene before recovering its replacement.')
      const identity = scene.shared
      if (!inverse) await this.request('collaboration/writeScene', [identity.sessionId, identity.itemId, change.sourceState])
      await this.request('collaboration/writeScene', [identity.sessionId, identity.itemId, inverse ? change.inverseUpdate : change.forwardUpdate])
    }
  }

  private async run(receipt: Receipt): Promise<WritingCommitResult> {
    if (receipt.phase === 'complete' && receipt.result) return receipt.result
    try {
      if (receipt.phase === 'prepared') {
        await this.publishShared(receipt, false)
        receipt.phase = 'shared'
        await this.save(receipt)
      }
      if (receipt.phase === 'shared') {
        receipt.result = await this.request<WritingCommitResult>('writing/commit', [receipt.request])
        if (receipt.result.status === 'retryable') return receipt.result
        receipt.phase = receipt.result.status === 'conflict' ? 'compensating' : 'complete'
        await this.save(receipt)
      }
      if (receipt.phase === 'compensating') {
        await this.publishShared(receipt, false)
        await this.publishShared(receipt, true)
        receipt.phase = 'complete'
        await this.save(receipt)
      }
      return receipt.result!
    } catch {
      return { status: 'retryable', operationId: receipt.request.transactionId, errorCode: 'writing.sharedReplacePending' }
    }
  }

  recover(context: WritingSearchContext): Promise<void> {
    const recovery = (this.recovery ?? Promise.resolve()).then(() => this.recoverReceipts(context))
    this.recovery = recovery
    void recovery.finally(() => { if (this.recovery === recovery) this.recovery = null }).catch(() => {})
    return recovery
  }

  private async recoverReceipts(context: WritingSearchContext): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const receipt = JSON.parse(await readFile(join(this.directory, name), 'utf8')) as Receipt
      if (receipt.context.workspaceId !== context.workspaceId) continue
      if (receipt.phase === 'complete') { await unlink(join(this.directory, name)); continue }
      receipt.context = context
      receipt.request.expectedEpoch = context.workspaceEpoch
      await this.save(receipt)
      if ((await this.run(receipt)).status === 'retryable') throw new Error('A writing replacement is waiting for recovery. Reconnect its shared scenes and retry.')
    }
  }
}
