import { create } from 'zustand'
import i18n from '../i18n'

interface UiDirectionState {
  /** True while the native menus are drawn in a different direction than the interface. */
  restartNeeded: boolean
}

export const useUiDirectionStore = create<UiDirectionState>(() => ({ restartNeeded: false }))

let reports = 0

/**
 * Tells the main process which direction the interface language reads in, so it
 * can remember it for the next launch and say whether the menus drawn by this
 * process now disagree. Absent on the mobile build, where there is no main process.
 */
export async function reportUiDirection(language: string | undefined): Promise<void> {
  const report = window.novalist?.setUiDirection
  if (!language || !report) return
  const mine = ++reports
  const restartNeeded = await report(i18n.dir(language) === 'rtl' ? 'rtl' : 'ltr').catch(() => false)
  if (mine === reports) useUiDirectionStore.setState({ restartNeeded })
}

/** Quits through the usual close guards and starts the app again. */
export function restartForUiDirection(): void {
  void window.novalist?.restartForUiDirection?.()
}
