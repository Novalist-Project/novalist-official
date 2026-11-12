import { editorPane, useProjectStore } from '../../stores/projectStore'
import { useShellStore } from '../../stores/shellStore'
import type { WritingDocumentRegistry } from '../../stores/writingDocuments'
import { acceptSharedWritingTransaction, acceptWritingTransaction, getWritingHistory } from '../../stores/writingHistory'
import { createSharedWritingBinding, getSharedWritingSession } from '../../collaboration/sharedWritingSessions'
import { SharedWritingHistory } from '../../collaboration/SharedWritingHistory'
import { WritingSharedPresence } from '../../collaboration/WritingSharedPresence'
import type { SharedSceneSession } from '../../collaboration/SharedSceneSession'
import type { SharedEditorSession } from '../../collaboration/SharedEditorSession'
import { getSharedWritingAnnotations, refreshSharedWritingAnnotations } from '../../collaboration/sharedWritingAnnotations'
import { useSharedProjectRevision } from '../../collaboration/sharedProjectNotifications'
import { WritingServiceScheduler } from './writingServiceScheduler'
import { WritingAnnotationRefresh } from './writingAnnotationRefresh'
import { writingEditingClaims } from '../../stores/writingEditingClaims'
import { writingTextMapping } from './writingTextMapping'
import { registerWritingNavigation, type WritingSceneTransform } from './writingNavigation'
import { applyWritingAnnotations, handleWritingAnnotationMessage, pushWritingAnnotations } from './writingAnnotationMessages'
import { resolveWritingAnnotationTransfers } from './writingAnnotationTransfers'
import type { WritingFrameAdapter } from './writingFrameAdapter'
import type { EditorMessage, EditorWindow } from './editorBridge'
import type { SceneRef, SceneSnapshot, WritingAnnotations, WritingPoint, WritingSelection, WritingTransaction } from './writingTypes'

export interface WritingStructureRequest {
  command: 'sceneBreak' | 'chapterHeading' | 'insertChapter' | 'insertScene'
  selection: WritingSelection | null
  anchor: SceneRef | null
  destination?: { beforeChapterGuid: string | null; actName: string | null }
  sceneDestination?: { chapterGuid: string; beforeSceneId: string | null }
}
interface PaneCallbacks {
  ready(editor: EditorWindow): void
  selection(selection: WritingSelection | null): void
  projection(): void
  error(reason: string): void
  structure(request: WritingStructureRequest): void
}

/** A pane binds retained documents; registry/history remain the write owners. */
export class WritingPaneController implements WritingFrameAdapter {
  pageViewEnabled = false
  changePageView?: (enabled: boolean) => void
  registry: WritingDocumentRegistry | null = null
  references = new Map<string, SceneRef>()
  private editor: EditorWindow | null = null
  private pending: WritingTransaction[] = []
  private activation = 0
  private activeScene: string | null = null
  private activatingScene: string | null = null
  private annotationScene: string | null = null
  private readonly sourceId: string
  private readonly sharedOwners = new Map<string, SharedSceneSession>()
  private readonly sharedBindings = new Map<string, SharedEditorSession>()
  private readonly sharedHistory = new SharedWritingHistory()
  private readonly presence = new WritingSharedPresence(sceneId =>
    !!this.editor?.document.hasFocus() && this.editor.getWritingSelection()?.focus.sceneId === sceneId)
  private scheduler: WritingServiceScheduler | null = null
  private projection: SceneSnapshot[] = []
  private projectionApplied = false
  private focusRequest: { registry: WritingDocumentRegistry; ref: SceneRef; selection: WritingSelection;
    scope?: { refs: readonly SceneRef[] | null; viewportOffset: number } } | null = null
  private unregisterNavigation: (() => void) | null = null
  private unobserveAnnotations: (() => void) | null = null
  private unsubscribeAnnotations: (() => void) | null = null
  private annotationRefresh: WritingAnnotationRefresh | null = null

  get context() { return this.registry?.context ?? null }

  constructor(private readonly paneId: string, public callbacks: PaneCallbacks) {
    this.sourceId = `writing:${paneId}:${crypto.randomUUID()}`
  }
  capture = (): void => {
    if (!this.editor || !this.registry) return
    this.pending.push(...this.editor.captureWritingChanges())
    while (this.pending.length) {
      const transaction = this.pending[0]
      this.accept(transaction)
      this.pending.shift()
    }
    this.updateServices()
  }
  private accept = (transaction: WritingTransaction): void => {
    const registry = this.registry
    if (!registry) throw new Error('writing.documentUnavailable')
    if (transaction.annotationTransfers?.length) {
      if (!this.editor) throw new Error('writing.documentUnavailable')
      transaction = resolveWritingAnnotationTransfers(registry, transaction, this.editor, this.sharedOwners)
    }
    if ([...transaction.changes, ...transaction.annotationChanges].some(change => registry.getSnapshot(change.ref)?.shared)) {
      acceptSharedWritingTransaction(registry, transaction, this.sharedHistory, this.sharedOwners)
    } else acceptWritingTransaction(registry, transaction)
  }
  ready = (editor: EditorWindow): void => {
    editor.configureWritingTextMapping(writingTextMapping)
    if (this.registry) editor.setWritingContext(this.registry.context, this.sourceId)
    editor.setWritingStructureEnabled(true)
    this.editor = editor
    this.unregisterNavigation?.()
    this.unregisterNavigation = registerWritingNavigation(this.paneId, this)
    this.callbacks.ready(editor)
  }
  message = (message: EditorMessage): boolean => {
    try {
      if (this.editor && this.registry && handleWritingAnnotationMessage(message, this.editor,
        this.registry, this.references, this.sourceId, this.accept)) return true
      if (!message.type.startsWith('writing') && message.type !== 'focused') return false
      if (message.type === 'writingChanged') this.capture()
      if (message.type === 'writingServicesChanged') this.updateServices()
      if (message.type === 'writingProjectionApplied') {
        this.projectionApplied = true
        this.bindShared(); this.applySceneFocus(); this.callbacks.projection()
      }
      if (message.type === 'writingSelectionChanged' || message.type === 'focused') {
        const selection = this.editor?.getWritingSelection() ?? null
        this.callbacks.selection(selection)
        this.updateServices()
        void this.activate(selection, message.type === 'focused').catch(this.reportError)
      }
      if (message.type === 'writingHistoryRequested') void this.changeHistory(message.direction === 'redo').catch(this.reportError)
      if (message.type === 'writingStructureRequested') this.requestStructure(message.command)
    } catch (reason) { this.reportError(reason) }
    return message.type !== 'focused'
  }
  private reportError = (reason: unknown): void => { this.callbacks.error(String(reason)) }
  cancelSceneFocus(): void { this.focusRequest = null }
  private pointBounds(point: WritingPoint): DOMRect | null {
    const position = this.editor?.writingDomPoint(point)
    if (!position || !this.editor) return null
    const range = this.editor.document.createRange()
    range.setStart(position.node, position.offset)
    range.collapse(true)
    return range.getBoundingClientRect()
  }
  retainScopePosition(): SceneRef | null {
    this.focusRequest = null
    this.capture()
    const editor = this.editor, registry = this.registry
    const viewport = editor?.document.getElementById('editor-wrapper')?.getBoundingClientRect()
    if (!editor || !registry || !viewport) return null
    let selection = editor.getWritingSelection()
    let ref = selection && this.references.get(selection.focus.sceneId)
    let bounds = ref && selection ? this.pointBounds(selection.focus) : null
    if (!ref || !bounds?.height || bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) {
      ref = undefined
      const visible = editor.writingServiceState()?.visibleSceneIds
      const candidates = visible?.length ? visible : [...this.references.keys()]
      for (const id of candidates) {
        const root = editor.getWritingSceneRoot(id)
        if (!root?.isConnected) continue
        const rect = root.getBoundingClientRect()
        if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue
        if (ref && bounds && rect.top >= bounds.top) continue
        const candidate = this.references.get(id)
        if (!candidate) continue
        ref = candidate
        bounds = rect
      }
      if (!ref) return null
      const point: WritingPoint = { sceneId: ref.sceneId, offset: 0, affinity: 'after' }
      selection = { anchor: point, focus: point }
      const caret = this.pointBounds(point)
      if (caret?.height) bounds = caret
    }
    if (!selection || !bounds) return null
    this.focusRequest = { registry, ref, selection, scope: { refs: null, viewportOffset: bounds.top - viewport.top } }
    return ref
  }
  restoreScopePosition(refs: readonly SceneRef[]): void {
    if (!this.focusRequest?.scope) return
    this.focusRequest.scope.refs = refs
    this.applySceneFocus()
  }
  focusScene(ref: SceneRef): void {
    if (!this.editor || !this.registry) return
    this.capture()
    const current = this.editor.getWritingSelection()
    const point = current?.focus.sceneId === ref.sceneId ? current.focus :
      { sceneId: ref.sceneId, offset: 0, affinity: 'after' as const }
    const selection = current?.anchor.sceneId === ref.sceneId && current.focus.sceneId === ref.sceneId
      ? current : { anchor: point, focus: point }
    this.focusRequest = { registry: this.registry, ref, selection }
    this.applySceneFocus()
  }
  private applySceneFocus(): void {
    const request = this.focusRequest
    if (!request || !this.editor) return
    if (request.registry !== this.registry) { this.focusRequest = null; return }
    if (!this.projectionApplied) return
    const expected = request.scope ? request.scope.refs : [request.ref]
    if (!expected || expected.length !== this.projection.length || expected.some((ref, index) => {
      const snapshot = this.projection[index]
      return snapshot.sceneId !== ref.sceneId || snapshot.bookId !== ref.bookId ||
        snapshot.draftId !== ref.draftId || snapshot.chapterGuid !== ref.chapterGuid
    }) || !this.editor.getWritingSceneRoot(request.ref.sceneId)?.isConnected) return
    const roots = this.editor.document.querySelectorAll<HTMLElement>('#editor > [data-writing-scene]')
    if (roots.length !== expected.length || expected.some((ref, index) => roots[index].dataset.writingScene !== ref.sceneId)) return
    const selection = expected.some(ref => ref.sceneId === request.selection.anchor.sceneId)
      ? request.selection : { anchor: request.selection.focus, focus: request.selection.focus }
    this.editor.focusEditor()
    if (this.reveal(request.ref, selection, request.scope?.viewportOffset)) this.focusRequest = null
  }
  reveal(ref: SceneRef, selection: WritingSelection, viewportOffset?: number): boolean {
    const displayed = this.references.get(ref.sceneId)
    if (!this.editor || !displayed || displayed.bookId !== ref.bookId || displayed.draftId !== ref.draftId ||
        displayed.chapterGuid !== ref.chapterGuid || !this.projectionApplied ||
        !this.projection.some(snapshot => snapshot.sceneId === ref.sceneId && snapshot.chapterGuid === ref.chapterGuid &&
          snapshot.bookId === ref.bookId && snapshot.draftId === ref.draftId) ||
        !this.editor.getWritingSceneRoot(ref.sceneId)?.isConnected) return false
    this.capture()
    this.editor.revealWritingPoint(selection.focus, viewportOffset)
    this.editor.restoreWritingSelection(selection)
    this.focusRequest = null
    return true
  }
  private async activate(selection: WritingSelection | null, renewFocus: boolean): Promise<void> {
    const editor = this.editor, owner = this.registry
    if (!owner || !editor?.document.hasFocus() || !selection) return
    const ref = this.references.get(selection.focus.sceneId)
    if (!ref || (!renewFocus && (this.activeScene === ref.sceneId || this.activatingScene === ref.sceneId))) return
    const generation = ++this.activation
    this.activatingScene = ref.sceneId
    const initialPane = editorPane(useProjectStore.getState(), this.paneId)
    const current = (): boolean => {
      const pane = editorPane(useProjectStore.getState(), this.paneId)
      return generation === this.activation && this.registry === owner && this.editor === editor &&
        pane.chapterGuid === initialPane.chapterGuid && pane.sceneId === initialPane.sceneId &&
        editor.document.hasFocus() && this.references.get(ref.sceneId)?.chapterGuid === ref.chapterGuid &&
        editor.getWritingSelection()?.focus.sceneId === ref.sceneId
    }
    try {
      const lease = await window.novalist.claimWritingFocus?.(this.sourceId, owner.context.workspaceEpoch)
      if (!lease || !current()) return
      if (!await owner.activate(ref, { ...lease, activationGeneration: generation })) return
      if (!current()) return
      this.activeScene = ref.sceneId
      writingEditingClaims.focus(this.sourceId, owner, ref)
      useShellStore.getState().setActivePane(this.paneId)
      useProjectStore.getState().setContextScene(ref.chapterGuid, ref.sceneId)
      useProjectStore.setState(state => ({ editors: {
        ...state.editors, [this.paneId]: { ...editorPane(state, this.paneId), chapterGuid: ref.chapterGuid, sceneId: ref.sceneId }
      } }))
    } finally {
      if (generation === this.activation) this.activatingScene = null
    }
  }

  private async changeHistory(redo: boolean): Promise<void> {
    this.capture()
    const owner = this.registry, editor = this.editor
    if (!owner || !editor) return
    const result = await getWritingHistory(owner)[redo ? 'redo' : 'undo']()
    if (result.status === 'blocked') this.callbacks.error(result.reason ?? 'writing.historyBlocked')
    else if (this.editor === editor && this.registry === owner && result.selection) editor.restoreWritingSelection(result.selection)
  }
  requestStructure(command: unknown): void {
    if (command !== 'sceneBreak' && command !== 'chapterHeading' && command !== 'insertChapter') return
    this.capture()
    const selection = this.editor?.getWritingSelection() ?? null
    this.callbacks.structure({ command, selection, anchor: this.references.get(selection?.focus.sceneId ?? '') ?? null })
  }
  private currentReference(): SceneRef | undefined {
    return this.references.get(this.editor?.getWritingSelection()?.focus.sceneId ?? this.annotationScene ?? '')
  }
  transformScene = (ref: SceneRef, transform: WritingSceneTransform): void => {
    const registry = this.registry, editor = this.editor, displayed = this.references.get(ref.sceneId)
    if (!registry || !editor || !displayed || displayed.bookId !== ref.bookId ||
        displayed.draftId !== ref.draftId || displayed.chapterGuid !== ref.chapterGuid) {
      throw new Error('writing.documentUnavailable')
    }
    this.capture()
    const snapshot = registry.getSnapshot(ref)
    if (!snapshot) throw new Error('writing.documentUnavailable')
    const shared = snapshot.shared ? this.sharedOwners.get(ref.sceneId) : undefined
    if (snapshot.shared && !shared) throw new Error('writing.documentUnavailable')
    const beforeHtml = shared?.html ?? snapshot.html
    const before = registry.getAnnotations(ref)
    const after = transform(beforeHtml, before)
    if (after.annotations && !before) throw new Error('writing.annotationsUnavailable')
    if (after.html === beforeHtml && !after.annotations) return
    this.accept({ id: crypto.randomUUID(), context: registry.context, origin: this.sourceId, kind: 'replace',
      changes: after.html === beforeHtml ? [] : [{ ref, beforeHtml, afterHtml: after.html,
        expectedRevision: shared?.revision ?? snapshot.revision, expectedHash: snapshot.hash }],
      annotationChanges: after.annotations && before ? [{ ref, before, after: after.annotations }] : [],
      beforeSelection: editor.getWritingSelection(), afterSelection: null })
  }
  readAnnotations = (): WritingAnnotations | null => {
    const ref = this.currentReference()
    return ref && this.registry ? this.registry.getAnnotations(ref) : null
  }
  writeAnnotations = (annotations: WritingAnnotations): void => {
    const ref = this.currentReference()
    if (ref) this.writeSceneAnnotations(ref, annotations)
  }
  writeSceneAnnotations = (ref: SceneRef, annotations: WritingAnnotations): void => {
    const displayed = this.references.get(ref.sceneId)
    if (!this.registry || !this.editor || !displayed || displayed.bookId !== ref.bookId ||
        displayed.draftId !== ref.draftId || displayed.chapterGuid !== ref.chapterGuid) {
      throw new Error('writing.annotationSceneUnavailable')
    }
    applyWritingAnnotations(this.editor, this.registry, ref, annotations, this.sourceId, this.accept)
    if (this.currentReference()?.sceneId === ref.sceneId) pushWritingAnnotations(this.editor, this.registry, ref)
  }
  update(snapshot: SceneSnapshot): void {
    if (snapshot.shared) {
      const owner = this.sharedOwners.get(snapshot.sceneId) ?? getSharedWritingSession(snapshot.shared)
      this.sharedOwners.set(snapshot.sceneId, owner)
      this.editor?.acknowledgeWritingScene({ ...snapshot, html: owner.html, revision: owner.revision })
    } else this.editor?.updateWritingScene(snapshot)
    if (this.editor && this.registry && this.annotationScene === snapshot.sceneId) pushWritingAnnotations(this.editor, this.registry, snapshot)
  }
  project(snapshots: SceneSnapshot[]): void {
    this.capture()
    this.projection = snapshots
    this.projectionApplied = false
    this.editor?.setWritingProjection(snapshots, null)
  }
  private bindShared(): void {
    const editor = this.editor
    if (!editor) return
    this.observeAnnotations()
    const displayed = new Set(this.projection.map(snapshot => snapshot.sceneId))
    for (const [id, binding] of this.sharedBindings) {
      if (displayed.has(id)) continue
      binding.detach()
      this.sharedBindings.delete(id)
    }
    for (const snapshot of this.projection) {
      if (!snapshot.shared || this.sharedBindings.has(snapshot.sceneId)) continue
      const owner = getSharedWritingSession(snapshot.shared)
      this.sharedOwners.set(snapshot.sceneId, owner)
      const binding = createSharedWritingBinding(editor, snapshot.sceneId, snapshot.shared, status => {
        if (status.error && status.error !== owner.error) this.callbacks.error(status.error.message)
        editor.acknowledgeWritingScene({ ...snapshot, html: owner.html, revision: owner.revision })
      }, this.capture)
      this.sharedBindings.set(snapshot.sceneId, binding)
      editor.acknowledgeWritingScene({ ...snapshot, html: owner.html, revision: owner.revision })
      void binding.refresh().catch(this.reportError)
    }
    this.updateServices()
  }
  private observeAnnotations(): void {
    const registry = this.registry
    if (!registry || this.unobserveAnnotations) return
    this.unobserveAnnotations = getSharedWritingAnnotations(registry).observe(error => { if (error) this.reportError(error) })
    this.annotationRefresh = new WritingAnnotationRefresh(refs => refreshSharedWritingAnnotations(registry, refs), this.reportError)
    this.unsubscribeAnnotations = useSharedProjectRevision.subscribe(() => this.refreshAnnotations())
    this.refreshAnnotations()
  }
  private refreshAnnotations(): void {
    const state = this.editor?.writingServiceState()
    if (!state || !this.registry) return
    const wanted = new Set([...state.visibleSceneIds, ...state.selectedSceneIds, state.activeSceneId, state.composingSceneId])
    const refs = [...wanted].flatMap(id => {
      const ref = id ? this.references.get(id) : undefined
      return ref && this.registry?.getSnapshot(ref)?.shared ? [ref] : []
    })
    this.annotationRefresh?.update(refs, useSharedProjectRevision.getState())
  }
  startServices(): (() => void) | undefined {
    const editor = this.editor, registry = this.registry
    if (!editor || !registry) return undefined
    const services = new WritingServiceScheduler({
      snapshot: sceneId => {
        const ref = this.references.get(sceneId)
        const snapshot = ref && registry.getSnapshot(ref)
        return snapshot ? { sceneId, revision: this.sharedOwners.get(sceneId)?.revision ?? snapshot.revision,
          contextKey: JSON.stringify(registry.context) } : undefined
      },
      start: request => {
        const root = editor.getWritingSceneRoot(request.sceneId)
        request.publish(() => { if (root) editor.toDisplayImages(root) })
        return { dispose: () => { if (root) editor.clearGrammarHighlights(root) } }
      }, onError: this.reportError
    })
    this.scheduler = services
    return () => { this.scheduler = null; void services.dispose().catch(this.reportError) }
  }
  private updateServices(): void {
    const state = this.editor?.writingServiceState()
    if (!state) return
    if (state.activeSceneId) {
      this.editor?.setWritingServiceScene(state.activeSceneId)
      const ref = this.references.get(state.activeSceneId)
      if (this.editor && this.registry && ref && this.annotationScene !== state.activeSceneId) {
        this.annotationScene = state.activeSceneId
        pushWritingAnnotations(this.editor, this.registry, ref)
      }
    }
    this.scheduler?.update({ ...state, composingSceneIds: state.composingSceneId ? [state.composingSceneId] : [] })
    const wanted = new Set([...state.visibleSceneIds, ...state.selectedSceneIds, state.activeSceneId])
    this.presence.update([...wanted].flatMap(sceneId => {
      const ref = sceneId ? this.references.get(sceneId) : undefined
      const identity = ref && this.registry?.getSnapshot(ref)?.shared
      const session = sceneId ? this.sharedBindings.get(sceneId) : undefined
      return sceneId && identity && session ? [{ sceneId, identity, session }] : []
    }))
    this.refreshAnnotations()
  }
  dispose = (): void => {
    this.capture()
    this.focusRequest = null
    writingEditingClaims.blur(this.sourceId)
    this.presence.close()
    for (const binding of this.sharedBindings.values()) binding.detach()
    this.sharedBindings.clear()
    this.unobserveAnnotations?.()
    this.unobserveAnnotations = null
    this.unsubscribeAnnotations?.()
    this.unsubscribeAnnotations = null
    this.annotationRefresh?.dispose()
    this.annotationRefresh = null
    this.unregisterNavigation?.()
    this.unregisterNavigation = null
    this.editor = null
    this.activation++
  }
}
