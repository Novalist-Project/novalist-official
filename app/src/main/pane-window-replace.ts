import type { SavedPaneWindow } from '../shared/paneWindows'

export interface PaneWindowReplaceHost<W> {
  /** The undocked windows open now. */
  open(): W[]
  /** Saves and closes exactly these windows; rejects when one refuses. */
  close(windows: W[]): Promise<void>
  /** Whether the app or the main window is closing every window. */
  closingAll(): boolean
  /** Opens recorded windows. */
  openSaved(windows: SavedPaneWindow[]): void
}

/**
 * Replaces the open undocked windows with a layout's, as one operation.
 *
 * Replacements run one at a time, so two quick applies cannot both see an
 * empty set and both open their windows. After the closes are saved the
 * situation is checked again: if the window that asked went away or the app
 * began to close everything meanwhile, nothing is opened.
 */
export class PaneWindowReplace<W> {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly host: PaneWindowReplaceHost<W>) {}

  /** `requesterAlive` says whether the window that asked is still the main window. */
  replace(windows: SavedPaneWindow[], requesterAlive: () => boolean): Promise<void> {
    const run = this.queue.then(() => this.run(windows, requesterAlive))
    this.queue = run.catch(() => {})
    return run
  }

  private async run(windows: SavedPaneWindow[], requesterAlive: () => boolean): Promise<void> {
    const ready = (): void => {
      if (!requesterAlive() || this.host.closingAll()) throw new Error('The main window is closing.')
    }
    ready()
    const open = this.host.open()
    if (open.length > 0) await this.host.close(open)
    ready()
    if (this.host.open().length > 0) throw new Error('An undocked window stayed open.')
    this.host.openSaved(windows)
  }
}
