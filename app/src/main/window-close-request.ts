import type { WindowCloseCoordinator } from './window-close'

interface CloseTarget {
  id: number
  webContents: { id: number }
  isDestroyed(): boolean
  close(): void
  once(event: 'closed', listener: () => void): unknown
}

interface WindowCloseRequestOptions {
  getMainWindow(): CloseTarget | null
  getWindows(): CloseTarget[]
  approvedCloses: Set<number>
  quit(): void
  /** Every window is about to close because the main window or the app is closing. */
  closingAll?(): void
}

export class WindowCloseRequests {
  private active: Promise<void> | null = null
  private allRequested = false
  private quitRequested = false

  constructor(private readonly coordinator: WindowCloseCoordinator, private readonly options: WindowCloseRequestOptions) {}

  /** Closes one window, or several as one transaction: one refusal keeps them all open. */
  request(target: CloseTarget | CloseTarget[], quit: boolean): Promise<void> {
    const requested = Array.isArray(target) ? target : [target]
    this.quitRequested ||= quit
    const main = this.options.getMainWindow()
    this.allRequested ||= quit || (main !== null && requested.includes(main))
    if (this.active) return this.active
    const operation = Promise.resolve().then(() => this.run(requested)).finally(() => {
      if (this.active === operation) { this.active = null; this.allRequested = false; this.quitRequested = false }
    })
    this.active = operation
    return operation
  }

  /**
   * Closes exactly these windows in a close of their own. A close already
   * under way - one window the writer is closing by hand - is waited out
   * rather than joined, so the caller learns whether *its* windows closed.
   */
  async requestOwn(targets: CloseTarget[]): Promise<void> {
    while (this.active) await this.active.catch(() => {})
    const open = targets.filter(window => !window.isDestroyed())
    if (open.length > 0) await this.request(open, false)
  }

  private async run(requested: CloseTarget[]): Promise<void> {
    for (;;) {
      const all = this.allRequested
      const targets = (all ? this.options.getWindows() : requested).filter(window => !window.isDestroyed())
      const prepared = await this.coordinator.prepare(targets.map(window => window.webContents.id),
        all ? this.options.getMainWindow()?.webContents.id : undefined)
      if (!all && this.allRequested) { await prepared.abort(); continue }
      await prepared.commit()
      if (all) this.options.closingAll?.()
      for (const window of targets) if (!window.isDestroyed()) this.options.approvedCloses.add(window.id)
      if (all && this.quitRequested) { this.options.quit(); return }
      await Promise.all(targets.filter(window => !window.isDestroyed()).map(window => new Promise<void>(resolve => {
        window.once('closed', resolve)
        window.close()
      })))
      if (all || !this.allRequested) return
    }
  }
}
