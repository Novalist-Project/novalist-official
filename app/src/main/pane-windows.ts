import { normalizePaneWindowContent, type PaneWindowContent, type SavedPaneWindow, type WindowBounds } from '../shared/paneWindows'

/** What the registry needs from a window; a BrowserWindow in production. */
export interface PaneWindowHandle {
  isDestroyed(): boolean
  getNormalBounds(): WindowBounds
  isMaximized(): boolean
}

interface Entry<W> {
  window: W
  content: PaneWindowContent
  /** Opened from recorded content rather than from a pop-out request. */
  restored: boolean
  /** The window's renderer has collected its content and may report changes. */
  collected: boolean
}

/**
 * The undocked pane windows that are open, and what each one shows.
 *
 * A window's content changes after it opens - its header retargets it, it can be
 * split, the writer moves to another scene - and only its own renderer knows,
 * so each one reports its content here. The registry is what a saved layout
 * and the remembered session read; the scene-notes window is not in it.
 */
export class PaneWindowRegistry<W extends PaneWindowHandle> {
  private readonly entries = new Map<number, Entry<W>>()

  constructor(
    private readonly workAreaOf: (bounds: WindowBounds) => WindowBounds | null,
    private readonly onChange: () => void = () => {}
  ) {}

  get size(): number {
    return this.entries.size
  }

  add(owner: number, window: W, content: PaneWindowContent, restored = false): void {
    this.entries.set(owner, { window, content, restored, collected: false })
    this.onChange()
  }

  has(owner: number): boolean {
    return this.entries.has(owner)
  }

  /**
   * A window's own account of what it shows. Ignored from anything not
   * registered, and from a window that has not collected its content yet - it
   * would describe the bare pane it starts as, not what it is about to show.
   */
  report(owner: number, input: unknown): void {
    const entry = this.entries.get(owner)
    const content = normalizePaneWindowContent(input)
    if (!entry || !entry.collected || !content) return
    if (JSON.stringify(content) === JSON.stringify(entry.content)) return
    entry.content = content
    this.onChange()
  }

  /**
   * The content a window's renderer opens with. A window opened by a pop-out
   * request reads its first content from its URL, so its first call gets null;
   * a restored window gets its recorded content. Any later call is a reload of
   * the same window, which gets what the window last showed.
   */
  take(owner: number): PaneWindowContent | null {
    const entry = this.entries.get(owner)
    if (!entry) return null
    const first = !entry.collected
    entry.collected = true
    return first && !entry.restored ? null : entry.content
  }

  remove(owner: number): void {
    if (this.entries.delete(owner)) this.onChange()
  }

  windows(): W[] {
    return [...this.entries.values()].map((entry) => entry.window).filter((window) => !window.isDestroyed())
  }

  list(): SavedPaneWindow[] {
    return [...this.entries.values()].filter((entry) => !entry.window.isDestroyed()).map((entry) => {
      const bounds = entry.window.getNormalBounds()
      return {
        content: entry.content,
        placement: { bounds, maximized: entry.window.isMaximized(), workArea: this.workAreaOf(bounds) }
      }
    })
  }
}
