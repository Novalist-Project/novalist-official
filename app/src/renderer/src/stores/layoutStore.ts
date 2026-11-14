import { create } from 'zustand'
import { modeOf } from '../shell/modes'
import { findPane, paneLeaves, reidentify, setPaneWritingScopeIn } from './shellPanes'
import { normalizeWritingDestination, normalizeWritingLayout } from './writingLayoutMigration'
import type { WritingScope } from '../views/editor/writingTypes'
import {
  BINDER_MAX,
  BINDER_MIN,
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  savePanelSize,
  setPaneViewIn,
  useShellStore,
  withSavedPanes,
  type BinderTab,
  type InspectorTab,
  type PaneNode,
  type MainView
} from './shellStore'

/**
 * Named workspace layouts.
 *
 * Novalist persisted exactly one panel geometry and always opened in the same
 * shape, so planning, drafting and revising meant dragging the same three
 * panels back and forth several times a day. A layout is a name for a shape:
 * save the one you are in, come back to it with one click.
 *
 * Stored in localStorage beside the panel sizes rather than through the
 * settings backend, because this is view state and follows the machine you
 * work on - the same reasoning that put the panel widths there.
 */
const STORAGE_KEY = 'nl.shell.layouts'

/** Everything a layout restores. Anything not listed here is left alone. */
export interface WorkspaceLayout {
  name: string
  mainView: MainView
  writingScope?: WritingScope
  panes?: PaneNode
  activePaneId?: string
  binderTab: BinderTab
  binderVisible: boolean
  binderWidth: number
  inspectorVisible: boolean
  inspectorWidth: number
  inspectorTab: InspectorTab
  notesDockVisible: boolean
  focusMode: boolean
}

function clamp(px: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(px)))
}

function read(): WorkspaceLayout[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return (parsed as WorkspaceLayout[]).filter(layout => typeof layout?.name === 'string').map(layout => {
      const destination = normalizeWritingDestination(layout.mainView, layout.writingScope, !window.novalist.isMobile)
      return { ...layout, mainView: destination.view === 'sceneNotes' ? 'write' : destination.view,
        writingScope: destination.writingScope,
        panes: layout.panes ? normalizeWritingLayout(layout.panes, !window.novalist.isMobile) : undefined }
    })
  } catch {
    return []
  }
}

function write(layouts: WorkspaceLayout[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layouts))
  } catch {
    // Private mode or a full quota. The session still works, it just forgets -
    // which is the same deal the panel sizes already make.
  }
}

/** The shape the window is in right now, under the given name. */
export function captureLayout(name: string): WorkspaceLayout {
  const s = useShellStore.getState()
  const pane = findPane(s.panes, s.activePaneId)
  return {
    name,
    mainView: s.mainView,
    writingScope: pane?.kind === 'leaf' && pane.view === 'write' ? pane.writingScope ?? 'manuscript' : undefined,
    panes: normalizeWritingLayout(s.panes, !window.novalist.isMobile),
    activePaneId: s.activePaneId,
    binderTab: s.binderTab,
    binderVisible: s.binderVisible,
    binderWidth: s.binderWidth,
    inspectorVisible: s.inspectorVisible,
    inspectorWidth: s.inspectorWidth,
    inspectorTab: s.inspectorTab,
    notesDockVisible: s.notesDockVisible,
    focusMode: s.focusMode
  }
}

interface LayoutState {
  layouts: WorkspaceLayout[]
  /** Saves the current shape. A repeated name overwrites rather than doubles. */
  save(name: string): void
  apply(name: string): void
  remove(name: string): void
  reload(): void
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  layouts: read(),
  save: (name) => {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    const captured = captureLayout(trimmed)
    // Overwrite in place so an updated layout keeps its position in the list -
    // a writer who re-saves "Drafting" means that one, not a second entry.
    const next = get().layouts.some((l) => l.name === trimmed)
      ? get().layouts.map((l) => (l.name === trimmed ? captured : l))
      : [...get().layouts, captured]
    write(next)
    set({ layouts: next })
  },
  apply: (name) => withSavedPanes(paneLeaves(useShellStore.getState().panes).map(pane => pane.id), () => {
    const layout = get().layouts.find((l) => l.name === name)
    if (!layout) return

    const shell = useShellStore.getState()
    const binderWidth = clamp(Number.isFinite(layout.binderWidth) ? layout.binderWidth : shell.binderWidth, BINDER_MIN, BINDER_MAX)
    const inspectorWidth = clamp(Number.isFinite(layout.inspectorWidth) ? layout.inspectorWidth : shell.inspectorWidth, INSPECTOR_MIN, INSPECTOR_MAX)
    const restored = layout.panes ? reidentify(layout.panes) : null
    const activeIndex = layout.panes ? paneLeaves(layout.panes).findIndex(pane => pane.id === layout.activePaneId) : -1
    const leaves = restored ? paneLeaves(restored) : []
    const candidate = leaves[activeIndex]
    const active = candidate?.view !== 'sceneNotes' ? candidate : undefined
    const activePane = active ?? leaves.find(pane => pane.view !== 'sceneNotes')
    const activePaneId = activePane?.id ?? shell.activePaneId
    const mainView = activePane && activePane.view !== 'sceneNotes' ? activePane.view : layout.mainView
    const panes = restored ?? setPaneViewIn(shell.panes, activePaneId, layout.mainView)
    useShellStore.setState({
      mainView,
      mode: modeOf(mainView) ?? shell.mode,
      // The content area is a tree of panes and the main area renders that tree,
      // so setting mainView alone restored a label and left the screen showing
      // whatever it already was.
      panes: !restored && layout.mainView === 'write'
        ? setPaneWritingScopeIn(panes, activePaneId, layout.writingScope ?? 'manuscript') : panes,
      activePaneId,
      extView: null,
      binderTab: ['chapters', 'smartLists', 'collections', 'bookmarks'].includes(layout.binderTab) ? layout.binderTab : shell.binderTab,
      binderVisible: typeof layout.binderVisible === 'boolean' ? layout.binderVisible : shell.binderVisible,
      binderWidth,
      inspectorVisible: typeof layout.inspectorVisible === 'boolean' ? layout.inspectorVisible : shell.inspectorVisible,
      inspectorWidth,
      inspectorTab: ['context', 'footnotes', 'inbox', 'notes'].includes(layout.inspectorTab) ? layout.inspectorTab : shell.inspectorTab,
      notesDockVisible: typeof layout.notesDockVisible === 'boolean' ? layout.notesDockVisible : shell.notesDockVisible,
      focusMode: typeof layout.focusMode === 'boolean' ? layout.focusMode : shell.focusMode
    })
    // The restored widths are also the ones a restart should come back to,
    // otherwise the next launch undoes the layout that was just applied.
    savePanelSize({ binderWidth, inspectorWidth })
    if (typeof layout.notesDockVisible === 'boolean' && shell.notesDockVisible !== layout.notesDockVisible) void window.novalist.toggleSceneNotes?.()
  }),
  remove: (name) => {
    const next = get().layouts.filter((l) => l.name !== name)
    write(next)
    set({ layouts: next })
  },
  reload: () => set({ layouts: read() })
}))
