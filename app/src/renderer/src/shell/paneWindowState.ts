import { useEffect, useRef, useState } from 'react'
import type { PaneWindowContent } from '../../../shared/paneWindows'
import { dockNotesPane, findPane, paneLeaves, reidentify, resize, withoutNotesPane, newLeaf } from '../stores/shellPanes'
import { normalizeWritingLayout } from '../stores/writingLayoutMigration'
import { useShellStore, type DockEdge, type PaneNode } from '../stores/shellStore'
import { editorPane, useProjectStore } from '../stores/projectStore'
import { useManuscriptStore } from '../stores/manuscriptStore'
import { useExtensionsStore } from '../stores/extensionsStore'

/** What this undocked window shows: ids and view names, never text. */
export function capturePaneWindowContent(): PaneWindowContent {
  const shell = useShellStore.getState()
  const project = useProjectStore.getState()
  const panes = withoutNotesPane(shell.panes) ?? shell.panes
  const leaves = paneLeaves(panes)
  const active = leaves.findIndex((leaf) => leaf.id === shell.activePaneId)
  return {
    panes,
    activePane: Math.max(0, active),
    scenes: leaves.flatMap((leaf, pane) => {
      const editor = editorPane(project, leaf.id)
      return leaf.view === 'write' && editor.chapterGuid && editor.sceneId
        ? [{ pane, chapterGuid: editor.chapterGuid, sceneId: editor.sceneId }] : []
    }),
    selectedSceneIds: useManuscriptStore.getState().composed,
    extView: shell.extView
  }
}

/** The pane tree a recorded window opens with, with fresh ids for this session. */
export function restoredPanes(content: PaneWindowContent): { panes: PaneNode; activePaneId: string } {
  const recorded = normalizeWritingLayout(content.panes as PaneNode, !window.novalist.isMobile)
  const panes = reidentify(withoutNotesPane(recorded) ?? newLeaf('write'))
  const leaves = paneLeaves(panes)
  const active = leaves[content.activePane] ?? leaves[0]
  return { panes, activePaneId: active.id }
}

/**
 * Opens each recorded scene that the open project still has, in its pane, then
 * restores the selected run. A workspace switch while the scenes open leaves
 * the rest alone: the recorded ids belong to the project that was there.
 */
export async function openRestoredScenes(content: PaneWindowContent, panes: PaneNode): Promise<void> {
  const joined = useProjectStore.getState()
  const switched = (): boolean => {
    const now = useProjectStore.getState()
    return now.workspaceEpoch !== joined.workspaceEpoch || now.projectPath !== joined.projectPath
  }
  // Opening a scene makes its pane the active one; the recorded active pane
  // is put back afterwards.
  const activePaneId = useShellStore.getState().activePaneId
  const leaves = paneLeaves(panes)
  for (const scene of content.scenes) {
    if (switched()) return
    const leaf = leaves[scene.pane]
    const project = useProjectStore.getState()
    const chapter = project.chapters.find((item) => item.guid === scene.chapterGuid)
    if (!leaf || !findPane(useShellStore.getState().panes, leaf.id) || !chapter?.scenes.some((item) => item.id === scene.sceneId)) continue
    await project.openSceneIn(leaf.id, chapter.guid, scene.sceneId)
  }
  if (switched()) return
  if (useShellStore.getState().activePaneId !== activePaneId) useShellStore.getState().setActivePane(activePaneId)
  const present = new Set(useProjectStore.getState().chapters.flatMap((item) => item.scenes.map((scene) => scene.id)))
  useManuscriptStore.setState({ composed: content.selectedSceneIds?.filter((id) => present.has(id)) ?? null })
}

/** Whether a pane tree is a split: two or more panes besides docked notes. */
export function isSplit(panes: PaneNode): boolean {
  return paneLeaves(panes).filter((leaf) => leaf.view !== 'sceneNotes').length >= 2
}

type DockedNotes = { notes: Extract<PaneNode, { kind: 'leaf' }>; edge: DockEdge; share: number }

/** Where a docked notes pane sits in a tree: its edge and its share of its split. */
function dockedNotes(panes: PaneNode): DockedNotes | null {
  const notes = paneLeaves(panes).find((leaf) => leaf.view === 'sceneNotes')
  if (!notes) return null
  const find = (node: PaneNode): DockedNotes | null => {
    if (node.kind === 'leaf') return null
    const index = node.children.findIndex((child) => child.id === notes.id)
    if (index >= 0) {
      const total = node.sizes.reduce((sum, size) => sum + size, 0) || 100
      const edge: DockEdge = node.direction === 'row' ? (index === 0 ? 'left' : 'right') : (index === 0 ? 'top' : 'bottom')
      return { notes, edge, share: (node.sizes[index] ?? 30) / total * 100 }
    }
    for (const child of node.children) {
      const found = find(child)
      if (found) return found
    }
    return null
  }
  return find(panes) ?? { notes, edge: 'right', share: 30 }
}

/**
 * A restored split with the notes pane that is docked now put back beside the
 * active pane, on the same edge and at the same share. The notes leaf keeps
 * its id, so the notes editor stays where it is rather than being handed over.
 */
function withDockedNotes(current: PaneNode, restored: PaneNode, targetId: string): PaneNode {
  const placement = dockedNotes(current)
  if (!placement) return restored
  const { notes, edge, share } = placement
  const carrier: PaneNode = { kind: 'split', id: `${notes.id}-carrier`, direction: 'row', children: [restored, notes], sizes: [50, 50] }
  const docked = dockNotesPane(carrier, targetId, edge)
  const resizeNotes = (node: PaneNode): PaneNode => {
    if (node.kind === 'leaf') return node
    const index = node.children.findIndex((child) => child.id === notes.id)
    if (index >= 0 && node.children.length === 2) return resize(node, node.id, index === 0 ? [share, 100 - share] : [100 - share, share])
    return { ...node, children: node.children.map(resizeNotes) }
  }
  return resizeNotes(docked)
}

/** An extension view that is no longer installed is dropped, leaving the view under it. */
function availableExtension(extView: PaneWindowContent['extView']): PaneWindowContent['extView'] {
  return extView && useExtensionsStore.getState().views.some((view) => view.extensionId === extView.extensionId && view.key === extView.key)
    ? extView : null
}

/**
 * The main window takes the split it had when this project was last open:
 * panes, sizes, views, the active pane, scenes and the selected run. Panes
 * whose scene or extension view is gone open without it.
 */
export async function restoreMainPanes(content: PaneWindowContent): Promise<void> {
  const shell = useShellStore.getState()
  const restored = restoredPanes(content)
  useShellStore.setState({
    panes: withDockedNotes(shell.panes, restored.panes, restored.activePaneId),
    activePaneId: restored.activePaneId,
    extView: availableExtension(content.extView)
  })
  useShellStore.getState().setActivePane(restored.activePaneId)
  await openRestoredScenes(content, restored.panes)
}

/**
 * Main window only: once a project has loaded, its split comes back, then the
 * undocked windows it had open when it was last closed. Only after that does
 * the main window start recording its split for this project, so the shape
 * it had before the project loaded is never recorded as this project's.
 */
export function usePaneWindowSession(): void {
  const loadedPath = useProjectStore((state) => state.isLoaded ? state.projectPath : null)
  // Scenes open through the draft's writing registry and are dropped by a
  // workspace transition, so the restore waits until the project's draft is
  // known and every window has finished joining the new workspace.
  const settledPath = useProjectStore((state) => state.isLoaded && state.activeDraftId && !state.workspaceBusy && !state.workspaceTransitionToken
    ? state.projectPath : null)
  const [restoredFor, setRestoredFor] = useState<string | null>(null)
  // Once per project load: a later transition in the same project (a draft
  // switch, a backend reconnect) must not put the recorded split back.
  const started = useRef<string | null>(null)
  useEffect(() => {
    if (loadedPath !== started.current) {
      started.current = null
      setRestoredFor(null)
    }
    if (!loadedPath || settledPath !== loadedPath || started.current === loadedPath || window.novalist.isMobile) return
    const projectPath = loadedPath
    started.current = projectPath
    const current = (): boolean => started.current === projectPath && useProjectStore.getState().projectPath === projectPath
    void (async () => {
      const content = await (window.novalist.mainPaneSession?.(projectPath) ?? Promise.resolve(null)).catch(() => null)
      if (content && current()) await restoreMainPanes(content)
    })().catch(() => {}).finally(() => {
      if (!current()) return
      setRestoredFor(projectPath)
      void window.novalist.restorePaneWindowSession?.(projectPath).catch(() => {})
    })
  }, [loadedPath, settledPath])
  useEffect(() => {
    if (!restoredFor || window.novalist.isMobile || !window.novalist.reportMainPanes) return
    let last: string | undefined
    return watchPaneContent(() => {
      const project = useProjectStore.getState()
      if (!project.isLoaded || project.projectPath !== restoredFor) return
      const content = isSplit(useShellStore.getState().panes) ? capturePaneWindowContent() : null
      const encoded = JSON.stringify(content)
      if (encoded === last) return
      last = encoded
      window.novalist.reportMainPanes?.(restoredFor, content)
    })
  }, [restoredFor])
}

/** Calls `send` now and, debounced, whenever the panes, editors or selected run change. */
function watchPaneContent(send: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (): void => {
    clearTimeout(timer)
    timer = setTimeout(send, 250)
  }
  send()
  const stops = [useShellStore.subscribe(schedule), useProjectStore.subscribe(schedule), useManuscriptStore.subscribe(schedule)]
  return () => { clearTimeout(timer); for (const stop of stops) stop() }
}

/** Keeps main's registry current with what this undocked window shows. */
export function usePaneWindowReport(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || window.novalist.isMobile || !window.novalist.reportPaneWindowState) return
    let last = ''
    return watchPaneContent(() => {
      const content = capturePaneWindowContent()
      const encoded = JSON.stringify(content)
      if (encoded === last) return
      last = encoded
      window.novalist.reportPaneWindowState?.(content)
    })
  }, [enabled])
}
