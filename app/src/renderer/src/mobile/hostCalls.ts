type PendingCall = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  method: string
  timeoutMs: number
  waitsForUser: boolean
  timer?: ReturnType<typeof setTimeout>
}

type HostReply = { id: number; ok: boolean; result?: unknown; error?: string; errorCode?: string }

export class HostCallChannel {
  private readonly pending = new Map<number, PendingCall>()
  private nextId = 1
  private failure: Error | null = null
  private visible = true
  private readonly send: (message: string) => void

  constructor(send: (message: string) => void) { this.send = send }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    for (const [id, pending] of this.pending) {
      if (!pending.waitsForUser) this.armTimeout(id, pending)
    }
  }

  private armTimeout(id: number, pending: PendingCall): void {
    clearTimeout(pending.timer)
    if (this.visible || pending.waitsForUser) {
      pending.timer = setTimeout(() => {
        this.pending.delete(id)
        pending.reject(new Error(`The mobile host did not acknowledge ${pending.method}. Its result is unknown; reopen the app before retrying a write.`))
      }, pending.timeoutMs)
    }
  }

  request<T>(method: string, args: unknown[], timeoutMs?: number): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const waitsForUser = method.startsWith('pick') || method === 'shareExport'
      const pending: PendingCall = {
        resolve: resolve as (value: unknown) => void, reject, method, waitsForUser,
        timeoutMs: timeoutMs ?? (waitsForUser ? 600_000 : method === 'readProjectAsset' ? 120_000 : 30_000)
      }
      this.pending.set(id, pending)
      this.armTimeout(id, pending)
      try { this.send(JSON.stringify({ id, method, args })) }
      catch (error) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  receive(reply: HostReply): void {
    const pending = this.pending.get(reply.id)
    if (!pending) return
    this.pending.delete(reply.id)
    clearTimeout(pending.timer)
    if (reply.ok) pending.resolve(reply.result)
    else if (reply.errorCode === 'permission-denied')
      pending.reject(new DOMException(reply.error ?? 'Permission denied.', 'NotAllowedError'))
    else pending.reject(new Error(reply.error ?? 'Mobile host call failed.'))
  }

  disconnect(error: Error): void {
    this.failure = error
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
