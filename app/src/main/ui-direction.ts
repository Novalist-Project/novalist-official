import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The two values Chromium's `--force-ui-direction` accepts. */
export type UiDirection = 'ltr' | 'rtl'

export const UI_DIRECTION_SWITCH = 'force-ui-direction'

// Languages Chromium (ICU) lays out right-to-left. A script subtag wins over
// the language, as in `ku-Arab` or `pa-Arab`.
const RTL_LANGUAGES = new Set(['ar', 'ckb', 'dv', 'fa', 'he', 'iw', 'ps', 'sd', 'ug', 'ur', 'yi'])
const RTL_SCRIPTS = new Set(['arab', 'hebr', 'thaa', 'syrc', 'adlm', 'nkoo'])

export function asDirection(value: unknown): UiDirection | null {
  return value === 'ltr' || value === 'rtl' ? value : null
}

/** The direction Chromium picks on its own for a locale tag such as `ar-EG`. */
export function naturalDirection(locale: string): UiDirection {
  const parts = locale.toLowerCase().split(/[-_]/)
  if (parts.slice(1).some(part => RTL_SCRIPTS.has(part))) return 'rtl'
  return RTL_LANGUAGES.has(parts[0]) ? 'rtl' : 'ltr'
}

/** Reads what {@link rememberDirection} wrote; anything else means "nothing remembered". */
export function parseStoredDirection(text: string): UiDirection | null {
  return asDirection(text.trim())
}

export function readStoredDirection(file: string, read: (path: string) => string = path => readFileSync(path, 'utf8')): UiDirection | null {
  try {
    return parseStoredDirection(read(file))
  } catch {
    return null
  }
}

/**
 * The `--force-ui-direction` value to add at startup, or null to leave Chromium
 * alone: macOS draws native menus and follows the system, a switch passed by
 * whoever launched the app is theirs to keep, and nothing remembered means
 * there is nothing to apply yet.
 */
export function uiDirectionSwitch(platform: NodeJS.Platform, hasSwitch: boolean, stored: UiDirection | null): UiDirection | null {
  if (platform === 'darwin' || hasSwitch) return null
  return stored
}

/**
 * The direction this process draws its menus in, or null when a restart can
 * never change it (macOS, or a switch the launcher passed and relaunching would
 * pass again). Otherwise the forced value, or Chromium's own for the locale.
 */
export function launchedDirection(platform: NodeJS.Platform, hasSwitch: boolean, applied: UiDirection | null, locale: () => string): UiDirection | null {
  if (platform === 'darwin' || hasSwitch) return null
  return applied ?? naturalDirection(locale())
}

export function restartNeeded(launched: UiDirection | null, current: UiDirection): boolean {
  return launched !== null && launched !== current
}

export interface DirectionFiles {
  read(path: string): string
  write(path: string, text: string): void
}

const realFiles: DirectionFiles = {
  read: path => readFileSync(path, 'utf8'),
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text, 'utf8')
  }
}

/** Remembers the direction for the next launch. Returns whether the file was written; never throws. */
export function rememberDirection(file: string, direction: UiDirection, files: DirectionFiles = realFiles): boolean {
  if (readStoredDirection(file, files.read) === direction) return false
  try {
    files.write(file, direction)
    return true
  } catch {
    return false
  }
}

/**
 * How to start the app again. An AppImage runs from a mount that is gone once
 * the process exits, so the image is launched rather than the binary inside
 * it; every other build starts again exactly as it was started.
 */
export function relaunchOptions(env: NodeJS.ProcessEnv, argv: string[]): { execPath: string; args: string[] } | undefined {
  return env.APPIMAGE ? { execPath: env.APPIMAGE, args: argv.slice(1) } : undefined
}

/**
 * A restart that is armed only for a quit that actually happens. The request
 * is live while the close flow runs; the flow calls {@link quitStarting} once
 * every window has approved its close, and only then does {@link willQuit}
 * relaunch. A close guard that refuses ends the request without ever arming it,
 * so a later ordinary quit stays an ordinary quit.
 */
export class RestartAfterQuit {
  private requested = false
  private committed = false

  async request(closeFlow: () => Promise<void>): Promise<void> {
    this.requested = true
    try {
      await closeFlow()
    } finally {
      this.requested = false
    }
  }

  quitStarting(): void {
    this.committed = this.requested
  }

  willQuit(relaunch: () => void): void {
    if (!this.committed) return
    this.committed = false
    relaunch()
  }
}
