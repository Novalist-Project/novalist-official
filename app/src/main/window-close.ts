import { randomUUID } from 'node:crypto'

import type { CloseStage } from '../shared/workspaceProtocol'
interface ClosingWindow {
  send(token: string, stage: CloseStage): void
  focus(): void
}

export interface PreparedWindowClose {
  commit(): Promise<void>
  abort(): Promise<void>
}

/** A close is a transaction: every participant stays locked until all saves
 * and the main window's close backup succeed, or all participants resume. */
export class WindowCloseCoordinator {
  private readonly windows = new Map<number, ClosingWindow>()
  private readonly pending = new Map<number, { token: string; stage: CloseStage; resolve(): void; reject(error: Error): void }>()
  private active: Promise<void> | null = null
  private readonly committedOwners = new Set<number>()

  constructor(private readonly timeout = 15_000,
    private readonly reportCompletionFailure = () => console.error('A closing window did not acknowledge completion.')) {}

  register(owner: number, window: ClosingWindow): void { this.windows.set(owner, window) }
  has(owner: number): boolean { return this.windows.has(owner) }
  remove(owner: number): void {
    this.windows.delete(owner)
    this.committedOwners.delete(owner)
    const pending = this.pending.get(owner)
    if (pending?.stage === 'commit') pending.reject(new Error('The closing window disconnected during committed cleanup.'))
    else pending?.resolve()
    this.pending.delete(owner)
  }
  acknowledge(owner: number, token: string, saved: boolean): void {
    const pending = this.pending.get(owner)
    if (!pending || pending.token !== token) return
    if (saved) pending.resolve()
    else {
      this.windows.get(owner)?.focus()
      pending.reject(new Error('A window could not save its pending edits.'))
    }
  }

  prepare(owners: number[], backupOwner?: number): Promise<PreparedWindowClose> {
    if (this.active) return this.active.then(() => this.prepare(owners, backupOwner))
    const participants = [...new Set(owners)].filter(owner => !this.committedOwners.has(owner))
    if (backupOwner !== undefined && !participants.includes(backupOwner)) backupOwner = undefined
    const token = randomUUID()
    let unlock!: () => void
    const lock = new Promise<void>(resolve => { unlock = resolve })
    this.active = lock
    const finish = (): void => { if (this.active === lock) this.active = null; unlock() }
    let decision: 'commit' | 'abort' | null = null
    let completion: Promise<void> | null = null
    const decide = (stage: 'commit' | 'abort'): Promise<void> => {
      if (decision === 'abort' && stage === 'commit') return Promise.reject(new Error('The close preparation was cancelled.'))
      if (completion) return completion
      decision = stage
      if (stage === 'commit') for (const owner of participants) this.committedOwners.add(owner)
      completion = this.complete(participants, token, stage).finally(finish)
      return completion
    }
    return this.preflight(participants, token, backupOwner)
      .then(() => ({ commit: () => decide('commit'), abort: () => decide('abort') }))
      .catch(async error => { await decide('abort'); throw error })
  }

  private async preflight(owners: number[], token: string, backupOwner?: number): Promise<void> {
    const flushed = await Promise.allSettled(owners.map(owner => this.ask(owner, token, 'flush')))
    const failed = flushed.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    if (backupOwner !== undefined) await this.ask(backupOwner, token, 'backup')
    const released = await Promise.allSettled(owners.map(owner => this.ask(owner, token, 'release')))
    const refused = released.find(result => result.status === 'rejected')
    if (refused?.status === 'rejected') throw refused.reason
  }

  private async complete(owners: number[], token: string, stage: 'abort' | 'commit'): Promise<void> {
    const results = await Promise.allSettled(owners.map(owner => this.ask(owner, token, stage)))
    if (results.some(result => result.status === 'rejected')) this.reportCompletionFailure()
  }

  private ask(owner: number, token: string, stage: CloseStage): Promise<void> {
    const window = this.windows.get(owner)
    if (!window) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('A window did not respond to the close request.')), this.timeout)
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        this.pending.delete(owner)
        if (error) reject(error)
        else resolve()
      }
      this.pending.set(owner, { token, stage, resolve: () => finish(), reject: finish })
      try { window.send(token, stage) }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    })
  }
}
