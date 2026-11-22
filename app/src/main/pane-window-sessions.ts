import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizePaneWindowContent, normalizeSavedPaneWindows, type PaneWindowContent, type SavedPaneWindow } from '../shared/paneWindows'

/**
 * A project's key in the remembered-windows file: a hash of its normalised
 * folder, so the file names no path. Projects have no other stable identity.
 */
export function projectSessionKey(projectPath: string, platform: NodeJS.Platform = process.platform): string {
  let path = resolve(projectPath).replace(/[\\/]+$/, '')
  if (platform === 'win32' || platform === 'darwin') path = path.toLowerCase()
  return createHash('sha256').update(path).digest('hex')
}

interface RememberedProject {
  key: string
  at: number
  windows: SavedPaneWindow[]
  /** The main window's split, when it was split. */
  main: PaneWindowContent | null
}

export interface SessionStorage {
  read(): string | null
  write(text: string): void
}

/**
 * The file on disk. A write goes to a temporary file that then replaces the
 * old one, so a crash part-way through leaves the previous file whole rather
 * than a truncated one that would read as empty and forget every project.
 */
export function fileSessionStorage(path: string): SessionStorage {
  return {
    read: () => { try { return readFileSync(path, 'utf8') } catch { return null } },
    write: (text) => {
      const temporary = `${path}.tmp`
      writeFileSync(temporary, text)
      renameSync(temporary, path)
    }
  }
}

/**
 * What each project had open on this machine, so it comes back the next time
 * that project is opened: its undocked windows, and the main window's split.
 *
 * Kept current while windows open, move and close, and while the main window's
 * panes change, so a crash loses nothing. A window closed by hand leaves the
 * set - all of them closed by hand leaves nothing to bring back. Closing the
 * main window or quitting closes every window too, and those closes must not
 * count: the window set is frozen first. The main window's split is recorded
 * per project by the main window itself and is not affected by freezing.
 */
export class PaneWindowSessions {
  private projects: RememberedProject[] | null = null
  private current: string | null = null
  private frozen = false

  constructor(
    private readonly storage: SessionStorage,
    private readonly now: () => number = Date.now,
    private readonly limit = 20
  ) {}

  /**
   * The open project changed. Returns that project's remembered windows.
   *
   * `carryOpen` says undocked windows are open and follow the workspace into
   * this project: they leave the project they came from, or closing them by
   * hand here would leave them remembered there.
   */
  enter(key: string, carryOpen = false): SavedPaneWindow[] {
    const previous = this.current
    this.current = key
    this.frozen = false
    const remembered = this.find(key)?.windows ?? []
    if (carryOpen && previous && previous !== key && this.find(previous)?.windows.length) {
      this.update(previous, { windows: [] }, false)
    }
    return remembered
  }

  /** The windows open now, for the current project. */
  record(windows: SavedPaneWindow[]): void {
    const key = this.current
    if (this.frozen || !key) return
    this.update(key, { windows }, true)
  }

  /** The main window's split for a project, or null when it is not split. */
  mainFor(key: string): PaneWindowContent | null {
    return this.find(key)?.main ?? null
  }

  /** Records the main window's split for a project; null forgets it. */
  recordMain(key: string, main: PaneWindowContent | null): void {
    if (JSON.stringify(this.find(key)?.main ?? null) === JSON.stringify(main)) return
    this.update(key, { main }, true)
  }

  private find(key: string): RememberedProject | undefined {
    return this.load().find((project) => project.key === key)
  }

  /** Changes one project's entry, dropping it once it remembers nothing. */
  private update(key: string, change: Partial<Pick<RememberedProject, 'windows' | 'main'>>, touch: boolean): void {
    const existing = this.find(key)
    const next: RememberedProject = { key, at: touch ? this.now() : existing?.at ?? 0, windows: existing?.windows ?? [], main: existing?.main ?? null, ...change }
    const others = this.load().filter((project) => project.key !== key)
    const keep = next.windows.length > 0 || next.main !== null
    this.projects = (keep ? [next, ...others] : others).sort((a, b) => b.at - a.at).slice(0, this.limit)
    this.persist()
  }

  private persist(): void {
    try { this.storage.write(JSON.stringify({ version: 1, projects: this.projects ?? [] })) }
    catch { /* Remembering windows is optional; the writer's work is not at stake. */ }
  }

  /** Every window is closing with the app: what is recorded now is what comes back. */
  freeze(): void {
    this.frozen = true
  }

  /** A window opened, so the session is live again. */
  thaw(): void {
    this.frozen = false
  }

  get isFrozen(): boolean {
    return this.frozen
  }

  private load(): RememberedProject[] {
    if (this.projects) return this.projects
    let parsed: unknown = null
    try { parsed = JSON.parse(this.storage.read() ?? 'null') }
    catch { parsed = null }
    const projects = parsed && typeof parsed === 'object' && Array.isArray((parsed as { projects?: unknown }).projects)
      ? (parsed as { projects: unknown[] }).projects : []
    this.projects = projects.flatMap((entry): RememberedProject[] => {
      const value = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null
      const windows = value ? normalizeSavedPaneWindows(value.windows) : []
      const main = value ? normalizePaneWindowContent(value.main) : null
      return value && typeof value.key === 'string' && /^[0-9a-f]{64}$/.test(value.key) && (windows.length > 0 || main)
        ? [{ key: value.key, at: Number(value.at) || 0, windows, main }] : []
    }).sort((a, b) => b.at - a.at).slice(0, this.limit)
    return this.projects
  }
}
