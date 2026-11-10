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
}

export class WindowCloseRequests {
  private active: Promise<void> | null = null
  private allRequested = false
  private quitRequested = false

  constructor(private readonly coordinator: WindowCloseCoordinator, private readonly options: WindowCloseRequestOptions) {}

  request(target: CloseTarget, quit: boolean): Promise<void> {
    this.quitRequested ||= quit
    this.allRequested ||= quit || target === this.options.getMainWindow()
    if (this.active) return this.active
    const operation = Promise.resolve().then(() => this.run(target)).finally(() => {
      if (this.active === operation) { this.active = null; this.allRequested = false; this.quitRequested = false }
    })
    this.active = operation
    return operation
  }

  private async run(target: CloseTarget): Promise<void> {
    for (;;) {
      const all = this.allRequested
      const targets = (all ? this.options.getWindows() : [target]).filter(window => !window.isDestroyed())
      const prepared = await this.coordinator.prepare(targets.map(window => window.webContents.id),
        all ? this.options.getMainWindow()?.webContents.id : undefined)
      if (!all && this.allRequested) { await prepared.abort(); continue }
      await prepared.commit()
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
