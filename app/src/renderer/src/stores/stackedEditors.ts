import { create } from 'zustand'
import { rpc } from '../rpc/client'
import type { SharedSceneIdentity } from '../../../shared/sharedScene'
import type { FormattingState } from '../views/editor/EditorToolbar'
import { mirror, useProjectStore, type ProjectStateDto } from './projectStore'
import { useSettingsStore } from './settingsStore'
import { useShellStore } from './shellStore'
import { stripHtml } from './projectPersistence'
import { hostPaneId, normalizeEditorScope, type EditorScope } from './stackedPaneIds'

/**
 * The scope the writing view is drawn in. A phone has no room for a stack
 * beside its prose, so it always edits one scene.
 */
export function currentEditorScope(): EditorScope {
  if (window.novalist.isMobile === true) return 'scene'
  return normalizeEditorScope(useSettingsStore.getState().view?.effective.editorScope)
}

/**
 * How many rows are holding each stacked editor entry. A row that scrolls
 * away and straight back - or React mounting it twice - takes the entry again
 * before the first release has finished writing, and the entry must survive
 * that release.
 */
const holders = new Map<string, number>()

function held(paneId: string): boolean {
  return (holders.get(paneId) ?? 0) > 0
}

/** Reads a stacked scene into its own editor entry. */
export async function loadStackedScene(paneId: string, chapterGuid: string, sceneId: string): Promise<void> {
  holders.set(paneId, (holders.get(paneId) ?? 0) + 1)
  const before = useProjectStore.getState()
  if (before.editors[paneId]?.sceneId === sceneId) return
  const epoch = before.workspaceEpoch
  const content = await rpc.request<{ html: string; hash: string; shared?: SharedSceneIdentity | null }>(
    'scenes/read',
    [chapterGuid, sceneId]
  )
  useProjectStore.setState((state) => {
    // The project changed, the row let go, or another load won the race.
    if (state.workspaceEpoch !== epoch || !held(paneId) || state.editors[paneId]?.sceneId === sceneId) return {}
    const editors = {
      ...state.editors,
      [paneId]: {
        chapterGuid,
        sceneId,
        html: content.html,
        hash: content.hash,
        shared: content.shared ?? null,
        plainText: stripHtml(content.html),
        tabs: [],
        isDirty: false
      }
    }
    return {
      editors,
      sceneHashes: { ...state.sceneHashes, [sceneId]: content.hash },
      ...mirror(editors, state.activeEditorPaneId)
    }
  })
  if (useStackedEditorStore.getState().pendingFocus === sceneId) activateEditorPane(paneId)
}

/**
 * Lets go of a stacked scene that left the stack. Its last keystrokes are
 * written first: scrolling a chapter out of the manuscript must never be a way
 * to lose words.
 */
export async function releaseStackedScene(paneId: string): Promise<void> {
  const remaining = Math.max(0, (holders.get(paneId) ?? 0) - 1)
  if (remaining > 0) holders.set(paneId, remaining)
  else holders.delete(paneId)
  const store = useProjectStore.getState()
  if (!store.editors[paneId]) return
  await store.flushPane(paneId)
  useProjectStore.setState((state) => {
    const editor = state.editors[paneId]
    if (held(paneId) || !editor || editor.isDirty) return {}
    const editors = { ...state.editors }
    delete editors[paneId]
    const active = state.activeEditorPaneId === paneId ? hostPaneId(paneId) : state.activeEditorPaneId
    return { editors, activeEditorPaneId: active, ...mirror(editors, active) }
  })
}

/**
 * Makes one editor the one the shell follows. The shell is told about the pane
 * holding it; the inspector, the status bar and the toolbar follow the scene.
 */
export function activateEditorPane(paneId: string): void {
  const shell = useShellStore.getState()
  const host = hostPaneId(paneId)
  if (shell.activePaneId !== host) shell.setActivePane(host)
  const state = useProjectStore.getState()
  if (!state.editors[paneId]?.sceneId) return
  if (useStackedEditorStore.getState().pendingFocus === state.editors[paneId].sceneId) {
    useStackedEditorStore.setState({ pendingFocus: null })
  }
  if (state.activeEditorPaneId === paneId) return
  useProjectStore.setState({ activeEditorPaneId: paneId, ...mirror(state.editors, paneId) })
}

interface StackedEditorState {
  /** The toolbar above a stack describes whichever scene has the caret. */
  formatting: FormattingState | null
  speaking: boolean
  /** A scene the binder asked for, waiting to be scrolled to. */
  scrollRequest: { sceneId: string; nonce: number } | null
  /** A scene to take the caret as soon as its editor has its prose. */
  pendingFocus: string | null
  publish(formatting: FormattingState, speaking: boolean): void
  revealScene(sceneId: string): void
}

export const useStackedEditorStore = create<StackedEditorState>((set) => ({
  formatting: null,
  speaking: false,
  scrollRequest: null,
  pendingFocus: null,
  publish: (formatting, speaking) => set({ formatting, speaking }),
  revealScene: (sceneId) => set((state) => ({
    scrollRequest: { sceneId, nonce: (state.scrollRequest?.nonce ?? 0) + 1 },
    pendingFocus: sceneId
  }))
}))

/** Writes a scene's synopsis from the column beside its prose. */
export async function setStackedSynopsis(chapterGuid: string, sceneId: string, synopsis: string): Promise<void> {
  await rpc.request('scenes/setSynopsis', [chapterGuid, sceneId, synopsis])
  useProjectStore.setState((state) => ({
    chapters: state.chapters.map((chapter) => chapter.guid !== chapterGuid ? chapter : {
      ...chapter,
      scenes: chapter.scenes.map((scene) => scene.id === sceneId ? { ...scene, synopsis } : scene)
    })
  }))
}

/**
 * Adds a scene straight after another one and puts the caret in it, so a
 * writer at the end of a scene can start the next without leaving the stack.
 */
export async function insertSceneAfter(chapterGuid: string, afterSceneId: string, title: string): Promise<void> {
  const known = new Set(useProjectStore.getState().chapters.flatMap((chapter) => chapter.scenes.map((scene) => scene.id)))
  let state = await rpc.request<ProjectStateDto>('project/createScene', [chapterGuid, title])
  const chapter = state.chapters.find((entry) => entry.guid === chapterGuid)
  const created = chapter?.scenes.find((scene) => !known.has(scene.id))
  const after = chapter?.scenes.find((scene) => scene.id === afterSceneId)
  if (chapter && created && after && created.order !== after.order + 1) {
    state = await rpc.request<ProjectStateDto>('project/reorderScene', [chapterGuid, created.id, after.order + 1])
  }
  useProjectStore.getState().applyState(state)
  if (created) useStackedEditorStore.getState().revealScene(created.id)
}
