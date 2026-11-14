import { rpc } from '../rpc/client'
import { capturePendingWrites } from './pendingWrites'
import { mirror, useProjectStore } from './projectStore'
import type { ProjectState } from './projectTypes'
import { stripHtml } from './projectPersistence'
import { useManuscriptStore, applyExternalManuscriptScene } from './manuscriptStore'
import { captureWritingSavedHashes, getCurrentWritingConflict, getPendingWritingResolution, refreshWritingOwners } from './writingExternalRefresh'
import type { WritingDiskConflict } from './writingDocuments'

export interface SceneDiskChange {
  chapterGuid: string
  sceneId: string
  html: string
  hash: string
  wordCount: number
}

let refreshing = false

// Live shared documents reconcile through collaboration notifications. Their
// saved files can lag the current CRDT and must never become a conflict base.
const sharedWorkspace = (state: ProjectState): boolean =>
  state.chapters.some(chapter => chapter.scenes.some(scene => !!scene.sharedProse))

/** Recheck on application focus; never flush stale prose before reading disk. */
export async function refreshExternalScenes(): Promise<void> {
  const initial = useProjectStore.getState()
  if (refreshing || !initial.isLoaded || initial.workspaceBusy || initial.workspaceSuspended || initial.changingSceneStructure ||
      (window.novalist.isMobile && sharedWorkspace(initial))) return
  refreshing = true
  try {
    capturePendingWrites()
    const before = useProjectStore.getState()
    if (!window.novalist.isMobile) {
      await refreshDesktopWriting(before)
      return
    }
    const manuscript = useManuscriptStore.getState().sections
    const versions = [
      ...Object.values(before.editors).flatMap(editor => editor.sceneId && editor.chapterGuid && editor.hash
        ? [{ chapterGuid: editor.chapterGuid, sceneId: editor.sceneId, hash: editor.hash }] : []),
      ...manuscript.flatMap(section => section.scenes.map(scene => ({
        chapterGuid: section.chapterGuid, sceneId: scene.sceneId, hash: scene.hash
      })))
    ]
    const result = await rpc.request<{ counts: { sceneId: string; wordCount: number }[]; changes: SceneDiskChange[] }>('scenes/refresh', [versions])
    const current = useProjectStore.getState()
    if (current.workspaceEpoch !== before.workspaceEpoch || current.projectPath !== before.projectPath ||
        current.activeBookId !== before.activeBookId || current.activeDraftId !== before.activeDraftId ||
        current.workspaceBusy || current.workspaceSuspended || current.changingSceneStructure || sharedWorkspace(current)) return
    capturePendingWrites()
    useProjectStore.setState(state => {
      // A completed save owns both its new base and its new outline count.
      const counts = new Map(result.counts
        .filter(item => state.sceneHashes[item.sceneId] === before.sceneHashes[item.sceneId])
        .map(item => [item.sceneId, item.wordCount]))
      const changes = new Map(result.changes.map(item => [item.sceneId, item]))
      const sceneHashes = { ...state.sceneHashes }
      let sceneConflict = state.sceneConflict
      const editors = Object.fromEntries(Object.entries(state.editors).map(([id, editor]) => {
        const change = editor.sceneId ? changes.get(editor.sceneId) : undefined
        const prior = before.editors[id]
        // A save or navigation that completed during the read owns the newer base.
        if (!change || editor.sceneId !== prior?.sceneId || editor.chapterGuid !== prior.chapterGuid || editor.hash !== prior.hash || editor.hash === change.hash) return [id, editor]
        if (editor.isDirty && editor.html !== change.html) {
          sceneConflict ??= { chapterGuid: change.chapterGuid, sceneId: change.sceneId,
            mine: editor.html ?? '', theirs: change.html, plainText: editor.plainText ?? '' }
          return [id, editor]
        }
        sceneHashes[change.sceneId] = change.hash
        return [id, { ...editor, html: change.html, plainText: stripHtml(change.html), hash: change.hash, isDirty: false }]
      }))
      return { editors, sceneHashes, sceneConflict, ...mirror(editors, state.activeEditorPaneId),
        dirtyMap: { ...state.dirtyMap, ...Object.fromEntries(result.changes.map(change => [change.sceneId,
          Object.values(editors).some(editor => editor.sceneId === change.sceneId && editor.isDirty)])) },
        chapters: state.chapters.map(chapter => ({ ...chapter, scenes: chapter.scenes.map(scene =>
          counts.has(scene.id) ? { ...scene, wordCount: counts.get(scene.id)! } : scene) })) }
    })
    for (const change of result.changes) {
      const prior = manuscript.find(section => section.chapterGuid === change.chapterGuid)?.scenes.find(scene => scene.sceneId === change.sceneId)
      if (prior) applyExternalManuscriptScene(change, prior.hash)
    }
  } finally { refreshing = false }
}

async function refreshDesktopWriting(before: ProjectState): Promise<void> {
  if (!before.projectPath || !before.activeBookId || !before.activeDraftId) return
  const context = { workspaceId: before.projectPath, workspaceEpoch: before.workspaceEpoch,
    bookId: before.activeBookId, draftId: before.activeDraftId }
  publishWritingConflict(getPendingWritingResolution(context))
  const countsRead = rpc.request<{ counts: { sceneId: string; wordCount: number; hash: string }[] }>('scenes/refresh', [[]])
  const [conflicts, result] = await Promise.all([refreshWritingOwners(context), countsRead])
  const current = useProjectStore.getState()
  if (current.projectPath !== context.workspaceId || current.workspaceEpoch !== context.workspaceEpoch ||
      current.workspaceBusy || current.workspaceSuspended || current.changingSceneStructure) return
  for (const conflict of conflicts) publishWritingConflict(conflict)
  if (current.activeBookId !== context.bookId || current.activeDraftId !== context.draftId) return
  const latestHashes = captureWritingSavedHashes(context)
  const counts = new Map(result.counts.filter(item => !latestHashes.has(item.sceneId) || item.hash === latestHashes.get(item.sceneId))
    .map(item => [item.sceneId, item.wordCount]))
  useProjectStore.setState(state => ({ chapters: state.chapters.map(chapter => ({ ...chapter,
    scenes: chapter.scenes.map(scene => !scene.sharedProse && counts.has(scene.id) ? { ...scene, wordCount: counts.get(scene.id)! } : scene)
  })) }))
}

function publishWritingConflict(conflict: WritingDiskConflict | null | undefined): void {
  const owned = conflict && getCurrentWritingConflict(conflict)
  const current = useProjectStore.getState()
  if (!owned || current.sceneConflict || current.projectPath !== owned.context.workspaceId ||
      current.workspaceEpoch !== owned.context.workspaceEpoch) return
  useProjectStore.setState({ sceneConflict: { chapterGuid: owned.ref.chapterGuid, sceneId: owned.ref.sceneId,
    mine: owned.mine, theirs: owned.theirs, plainText: stripHtml(owned.mine), writing: owned } })
}
