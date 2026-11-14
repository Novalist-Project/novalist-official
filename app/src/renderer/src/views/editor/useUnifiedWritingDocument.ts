import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { editorPane, useProjectStore } from '../../stores/projectStore'
import { findPane, useShellStore } from '../../stores/shellStore'
import { resolveWritingProjection } from '../../stores/writingProjection'
import { observeWritingPersistence } from '../../stores/writingPersistence'
import { useFilterStore } from '../../stores/filterStore'
import { useManuscriptStore } from '../../stores/manuscriptStore'
import { WritingPaneController, type WritingStructureRequest } from './writingPaneController'
import type { EditorWindow } from './editorBridge'
import type { SceneRef, SceneSnapshot, WritingScope, WritingSelection } from './writingTypes'
import { useWritingEntityNames } from './useWritingEntityNames'
import { flushPendingWrites } from '../../stores/pendingWrites'
import { findSharedWritingSession } from '../../collaboration/sharedWritingSessions'
export type { WritingStructureRequest } from './writingPaneController'

function useSharedWritingError(snapshots: SceneSnapshot[], projectionRevision: number) {
  const [error, setError] = useState<string | null>(null)
  const observed = useRef(new WeakSet<object>())
  useEffect(() => {
    const owners = snapshots.flatMap(snapshot => {
      const owner = snapshot.shared ? findSharedWritingSession(snapshot.shared) : undefined
      return owner ? [owner] : []
    })
    const update = (): void => {
      for (const owner of owners) if (owner.error) observed.current.add(owner.error)
      setError(owners.find(owner => owner.error)?.error?.message ?? null)
    }
    const unsubscribe = owners.map(owner => owner.subscribe(update))
    update()
    return () => { unsubscribe.forEach(dispose => dispose()) }
  }, [snapshots, projectionRevision])
  return { error, owns: (reason: unknown): boolean =>
    typeof reason === 'object' && reason !== null && observed.current.has(reason) }
}

function useWritingProjection(paneId: string) {
  const chapters = useProjectStore(state => state.chapters)
  const pane = useProjectStore(state => editorPane(state, paneId))
  const epoch = useProjectStore(state => state.workspaceEpoch)
  const bookId = useProjectStore(state => state.activeBookId)
  const draftId = useProjectStore(state => state.activeDraftId)
  const filter = useFilterStore(state => state.filter)
  const entities = useWritingEntityNames(filter)
  const selectedSceneIds = useManuscriptStore(state => state.composed)
  const registry = useMemo(() => useProjectStore.getState().getWritingRegistry(), [epoch, bookId, draftId])
  const scope = useShellStore(state => {
    const leaf = findPane(state.panes, paneId)
    return leaf?.kind === 'leaf' ? leaf.writingScope ?? 'manuscript' : 'manuscript'
  })
  const anchor = pane.chapterGuid && pane.sceneId && bookId && draftId
    ? { bookId, draftId, chapterGuid: pane.chapterGuid, sceneId: pane.sceneId } : null
  const retainedRefs = useRef<ReturnType<typeof resolveWritingProjection>>([])
  const refs = useMemo(() => {
    const next = registry ? resolveWritingProjection(chapters, {
      context: registry.context, scope, anchor, selectedSceneIds, filter, entityNames: entities.names
    }) : []
    const previous = retainedRefs.current
    if (previous.length !== next.length || next.some((ref, index) => {
      const before = previous[index]
      return ref.bookId !== before.bookId || ref.draftId !== before.draftId ||
        ref.chapterGuid !== before.chapterGuid || ref.sceneId !== before.sceneId
    })) retainedRefs.current = next
    return retainedRefs.current
  }, [registry, chapters, scope, scope === 'manuscript' ? null : pane.chapterGuid,
    scope === 'scene' ? pane.sceneId : null, filter, selectedSceneIds, entities.names])
  return { registry, scope, refs, chapters, anchor, selectedSceneIds, projectionError: entities.error }
}

export function useUnifiedWritingDocument(paneId: string, onStructure: (request: WritingStructureRequest) => void) {
  const projection = useWritingProjection(paneId)
  const { registry, refs } = projection
  const [live, setLive] = useState<EditorWindow | null>(null)
  const [snapshots, setSnapshots] = useState<SceneSnapshot[]>([])
  const [loadedRefs, setLoadedRefs] = useState<typeof refs | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<WritingSelection | null>(null)
  const [projectionRevision, setProjectionRevision] = useState(0)
  const sharedError = useSharedWritingError(snapshots, projectionRevision)
  const callbacks = { ready: setLive, error: setError, structure: onStructure,
    projection: () => setProjectionRevision(value => value + 1),
    selection: (next: WritingSelection | null) => setSelection(previous => previous?.focus.sceneId === next?.focus.sceneId ? previous : next) }
  const adapter = useMemo(() => new WritingPaneController(paneId, callbacks), [paneId])
  adapter.registry = registry
  adapter.references = useMemo(() => new Map(refs.map(ref => [ref.sceneId, ref])), [refs])
  adapter.callbacks = callbacks
  useLayoutEffect(() => adapter.restoreScopePosition(refs), [adapter, projection.scope, refs])
  useLayoutEffect(() => () => adapter.dispose(), [adapter])
  useEffect(() => adapter.startServices(), [adapter, registry, live])
  useEffect(() => {
    if (!registry) return
    return observeWritingPersistence(registry, status => {
      if (status.error) setError(typeof status.error === 'string' ? status.error :
        status.error.status === 'conflict' ? 'writing.conflict' : status.error.errorCode)
    })
  }, [registry])
  useEffect(() => {
    if (!registry || !live) return
    let disposed = false
    adapter.capture()
    const unsubscribe = refs.map(ref => registry.subscribe(ref, snapshot => adapter.update(snapshot)))
    void Promise.all(refs.map(ref => registry.read(ref))).then(next => {
      if (!disposed) { setSnapshots(next); setLoadedRefs(refs); setError(null) }
    }).catch(reason => { if (!disposed) setError(String(reason)) })
    const unregisterCapture = registry.registerCapture(adapter.capture)
    return () => { disposed = true; adapter.capture(); unsubscribe.forEach(dispose => dispose()); unregisterCapture() }
  }, [registry, live, refs, adapter])
  useEffect(() => {
    if (!live || snapshots.length !== refs.length || snapshots.some((snapshot, index) => snapshot.sceneId !== refs[index].sceneId)) return
    adapter.project(snapshots)
  }, [live, snapshots, refs, adapter])
  const setScope = useCallback((writingScope: WritingScope, focus?: SceneRef): void => {
    if (!focus && writingScope === projection.scope) return
    if (focus) adapter.focusScene(focus)
    const anchor = focus ?? adapter.retainScopePosition()
    useShellStore.getState().setPaneWritingScope(paneId, writingScope)
    useProjectStore.setState(state => ({ editors: {
      ...state.editors, [paneId]: { ...editorPane(state, paneId), writingScope,
        ...(anchor ? { chapterGuid: anchor.chapterGuid, sceneId: anchor.sceneId } : {}) }
    } }))
  }, [adapter, paneId, projection.scope])
  const retry = async (): Promise<void> => {
    if (!registry) return
    try {
      adapter.capture()
      await flushPendingWrites()
      setSnapshots(await Promise.all(refs.map(ref => registry.read(ref))))
      setLoadedRefs(refs)
      setError(null)
    } catch (reason) { if (!sharedError.owns(reason)) setError(String(reason)) }
  }
  const visibleError = sharedError.error ?? error ?? projection.projectionError
  const loading = !visibleError && loadedRefs !== refs
  return { ...projection, adapter, live, snapshots, selection, setScope, retry, loading, error: visibleError, projectionRevision }
}
