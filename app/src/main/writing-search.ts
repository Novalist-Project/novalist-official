import { randomUUID } from 'node:crypto'
import type { WritingSearchCapture, WritingSearchCaptureReply, WritingSearchCaptureRequest, WritingSearchContext } from '../shared/writingSearchProtocol'

export class WritingSearchCaptureBroker {
  private readonly owners = new Map<number, (request: WritingSearchCaptureRequest) => void>()
  private readonly pending = new Map<string, { remaining: Set<number>; results: WritingSearchCapture[];
    requester?: number; resolve(results: WritingSearchCapture[]): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()

  register(owner: number, send: (request: WritingSearchCaptureRequest) => void): void { this.owners.set(owner, send) }

  remove(owner: number): void {
    this.owners.delete(owner)
    for (const [token, pending] of this.pending) {
      if (pending.remaining.has(owner)) this.fail(token, 'A writing window closed during search capture.')
    }
  }

  capture(context: WritingSearchContext, requester?: number): Promise<WritingSearchCapture[]> {
    const token = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(token, 'A writing window did not finish search capture.'), 15_000)
      this.pending.set(token, { remaining: new Set(this.owners.keys()), results: [], requester, resolve, reject, timer })
      if (!this.owners.size) { this.fail(token, 'No writing windows are ready.'); return }
      for (const send of this.owners.values()) send({ ...context, token })
    })
  }

  acknowledge(owner: number, reply: WritingSearchCaptureReply): void {
    const pending = this.pending.get(reply.token)
    if (!pending?.remaining.has(owner)) return
    if (reply.error || !reply.snapshots) { this.fail(reply.token, reply.error ?? 'Writing capture failed.'); return }
    pending.remaining.delete(owner)
    pending.results.push({ owner, snapshots: reply.snapshots })
    if (pending.remaining.size) return
    clearTimeout(pending.timer)
    this.pending.delete(reply.token)
    pending.resolve(pending.results.sort((a, b) => Number(b.owner === pending.requester) - Number(a.owner === pending.requester)))
  }

  private fail(token: string, message: string): void {
    const pending = this.pending.get(token)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(token)
    pending.reject(new Error(message))
  }
}
