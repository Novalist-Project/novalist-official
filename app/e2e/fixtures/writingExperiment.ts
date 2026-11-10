import * as Y from 'yjs'
import { SceneMarkup } from '../../src/renderer/src/collaboration/sceneMarkup'
import { updateRichText } from '../../src/renderer/src/collaboration/richText'
import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'
import type { FixtureBook } from './writingBook'
import type { WritingCommand, WritingPane, WritingPoint } from './writingContract'
import { applySimpleInsertion } from './writingIncremental'
import { installScenePagination } from './writingPageLayout'
import { installSceneCapture, type CaptureTelemetry } from './writingSceneCapture'
import { authoredClass, clearWritingSpacing, contentRecords, scenePoint, WritingPresentation, writingSpacingAttributes } from './writingPresentation'
import type { WritingViewport } from './writingViewport'

interface SceneDocument { doc: Y.Doc; text: Y.Text; history: Y.UndoManager }
interface SceneView { root: HTMLElement; markup: SceneMarkup; state: SceneDocument }
interface RelativePoint { scene: number; position: Y.RelativePosition }
interface LogicalSelection { anchor: RelativePoint; focus: RelativePoint }
interface ExperimentEditor extends EditorWindow {
  wrapSelectionAsComment(id: string): string | null
  sanitizePastedHtml(html: string): string
  NovalistEditorState: { pageViewMutationObserver: MutationObserver | null; isComposing: boolean; isSettingContent: boolean }
  schedulePageViewRepaginate(): void
  getCleanContentHtml(root?: HTMLElement): string
  buildGrammarPlainTextMap(root?: HTMLElement): { plainText: string; textNodes: unknown[] }
  reportContentChanged(): void
  sendMessage(message: object): void
  writingCaptureTelemetry: CaptureTelemetry
  writingViewport?: WritingViewport
}

const writer = {}

class ExperimentMarkup extends SceneMarkup {
  read() {
    return super.read().map(run => {
      if (!run.attributes?.block) return run
      const blocks: { attributes: Record<string, string> }[] = JSON.parse(run.attributes.block)
      for (const block of blocks) {
        for (const name of writingSpacingAttributes) delete block.attributes[name]
        if (!('class' in block.attributes)) continue
        const value = authoredClass(block.attributes.class)
        if (value) block.attributes.class = value
        else delete block.attributes.class
      }
      return { ...run, attributes: { ...run.attributes, block: JSON.stringify(blocks) } }
    })
  }
}

class CompoundHistory {
  readonly undoGroups: number[][] = []
  readonly redoGroups: number[][] = []
  constructor(readonly scenes: SceneDocument[]) {}

  capture(views: SceneView[], indices: number[]): void {
    const changed: number[] = []
    for (const index of indices) {
      const { state, markup } = views[index]
      state.history.stopCapturing()
      const size = state.history.undoStack.length
      state.doc.transact(() => updateRichText(state.text, markup.read()), writer)
      if (state.history.undoStack.length > size) changed.push(index)
    }
    if (changed.length) {
      this.undoGroups.push(changed)
      this.redoGroups.length = 0
    }
  }

  change(redo: boolean): void {
    const from = redo ? this.redoGroups : this.undoGroups
    const to = redo ? this.undoGroups : this.redoGroups
    const group = from.pop()
    if (!group) return
    for (const index of group) {
      if (redo) this.scenes[index].history.redo()
      else this.scenes[index].history.undo()
    }
    to.push(group)
  }
}

class ExperimentPane implements WritingPane {
  private readonly presentation = new WritingPresentation()
  private readonly root: HTMLElement
  private readonly views: SceneView[]
  private readonly observer: MutationObserver
  private readonly dirty = new Set<number>()
  private readonly latencies: number[] = []
  private applying = false
  private composing = false
  private commanding = false
  private pendingScope: number[] | null = null
  private savedSelection: LogicalSelection | null = null
  private readonly viewIndices = new Map<HTMLElement, number>()
  private acceptSceneContent: ((scene: HTMLElement) => () => void) | undefined

  constructor(private readonly editor: ExperimentEditor, private readonly book: FixtureBook, private readonly history: CompoundHistory, optimized: boolean, scoped: boolean) {
    this.root = editor.document.getElementById('editor')!
    this.root.replaceChildren()
    const presentation = this.presentation
    this.views = book.scenes.map((scene, index) => {
      const root = editor.document.createElement('section')
      root.dataset.sceneId = scene.id
      root.append(editor.sanitizeSceneFragment(scene.html))
      this.root.append(root)
      this.viewIndices.set(root, index)
      const markup = new ExperimentMarkup({ document: editor.document,
        sanitizeSceneFragment: html => editor.sanitizeSceneFragment(html),
        toDisplayImages: content => editor.toDisplayImages(content) }, root)
      const state = history.scenes[index]
      if (!state.text.length) state.doc.transact(() => updateRichText(state.text, markup.read()))
      else markup.render(state.text.toDelta())
      const transactionSelections = new WeakMap<Y.Transaction, LogicalSelection | null>()
      state.doc.on('beforeTransaction', transaction => {
        if (!this.applying && !this.composing && this.selectionTouches(index)) transactionSelections.set(transaction, this.selection() ?? this.savedSelection)
      })
      state.text.observe(event => {
        if (this.applying || this.composing) return
        const saved = transactionSelections.get(event.transaction)
        this.markDirty(contentRecords(this.observer.takeRecords()))
        const acknowledge = this.acceptSceneContent?.(root)
        if (!optimized || !applySimpleInsertion(markup, event.delta)) this.render(index)
        this.markDirty(contentRecords(this.observer.takeRecords()).filter(record => !root.contains(record.target)))
        acknowledge?.()
        if (saved) { this.savedSelection = saved; this.restore(saved) }
      })
      return { root, markup, state }
    })
    this.observer = presentation.observe(this.root, records => this.markDirty(records))
    if (optimized) {
      const style = editor.document.createElement('style')
      style.textContent = '#editor [data-scene-id] { content-visibility: auto; contain-intrinsic-size: auto 600px; }'
      editor.document.head.append(style)
      installScenePagination(editor, presentation)
    }
    editor.setCommentsData(Array.from(this.root.querySelectorAll<HTMLElement>('[data-comment-id]'), mark => ({ id: mark.dataset.commentId!, anchorText: mark.textContent ?? '', text: 'Synthetic annotation' })))
    if (scoped) this.acceptSceneContent = installSceneCapture(editor, presentation)
    this.installEvents()
  }

  private installEvents(): void {
    this.root.addEventListener('input', event => {
      const start = event.timeStamp
      this.editor.requestAnimationFrame(() => this.editor.requestAnimationFrame(() => this.latencies.push(this.editor.performance.now() - start)))
      if (!this.composing) this.capture()
    })
    this.root.addEventListener('beforeinput', event => this.beforeInput(event), true)
    this.root.addEventListener('keydown', event => {
      if (this.composing || event.isComposing || event.keyCode === 229 || event.altKey || !(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (key === 'y' || event.shiftKey) this.redo()
      else this.undo()
    }, true)
    this.root.addEventListener('copy', event => this.copy(event))
    this.root.addEventListener('paste', event => this.paste(event), true)
    this.root.addEventListener('compositionstart', () => {
      this.capture()
      this.composing = true
      const ranges = this.selectedRanges()
      if (ranges.length > 1) this.replaceRanges(ranges)
    })
    this.root.addEventListener('compositionend', () => {
      this.editor.setTimeout(() => {
        this.composing = false
        this.capture()
        if (this.pendingScope) this.scope(this.pendingScope)
        this.pendingScope = null
      }, 0)
    })
    this.editor.document.addEventListener('selectionchange', () => {
      const active = this.activeScene()
      if (active) this.editor.setSceneContext(active)
    })
  }

  private markDirty(records: MutationRecord[]): void {
    for (const record of records) {
      const node = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement
      const root = node?.closest('[data-scene-id]')
      const index = this.viewIndices.get(root as HTMLElement)
      if (index !== undefined) this.dirty.add(index)
    }
  }

  capture(): void {
    if (this.composing || this.applying || this.commanding) return
    this.markDirty(contentRecords(this.observer.takeRecords()))
    this.applying = true
    try { this.history.capture(this.views, [...this.dirty]) }
    finally { this.applying = false; this.dirty.clear() }
  }

  private render(index: number): void {
    const view = this.views[index]
    view.markup.render(view.state.text.toDelta())
  }

  private point(node: Node, offset: number): RelativePoint | null {
    const resolved = scenePoint(this.root, node, offset)
    const scene = resolved ? this.viewIndices.get(resolved.scene) : undefined
    if (scene === undefined || this.views[scene].root.hidden) return null
    const view = this.views[scene]
    view.markup.read()
    const index = view.markup.position(resolved!.node, resolved!.offset)
    return index === null ? null : { scene, position: Y.createRelativePositionFromTypeIndex(view.state.text, index) }
  }

  private selectionTouches(index: number): boolean {
    const selected = this.editor.getSelection()
    const a = scenePoint(this.root, selected?.anchorNode ?? null, selected?.anchorOffset ?? 0)
    const f = scenePoint(this.root, selected?.focusNode ?? null, selected?.focusOffset ?? 0)
    const anchor = a ? this.viewIndices.get(a.scene) : this.savedSelection?.anchor.scene
    const focus = f ? this.viewIndices.get(f.scene) : this.savedSelection?.focus.scene
    return anchor !== undefined && focus !== undefined && index >= Math.min(anchor, focus) && index <= Math.max(anchor, focus)
  }

  private selection(): LogicalSelection | null {
    const selection = this.editor.getSelection()
    if (!selection?.anchorNode || !selection.focusNode) return null
    const anchor = this.point(selection.anchorNode, selection.anchorOffset)
    const focus = this.point(selection.focusNode, selection.focusOffset)
    return anchor && focus ? { anchor, focus } : null
  }

  private restore(selection: LogicalSelection): void {
    if (this.views[selection.anchor.scene].root.hidden || this.views[selection.focus.scene].root.hidden) return
    const resolve = (point: RelativePoint) => {
      const view = this.views[point.scene]
      view.markup.read()
      const position = Y.createAbsolutePositionFromRelativePosition(point.position, view.state.doc)
      return position ? view.markup.domPosition(position.index) : null
    }
    const anchor = resolve(selection.anchor)
    const focus = resolve(selection.focus)
    if (anchor && focus) this.editor.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
  }

  select(anchor: WritingPoint, focus: WritingPoint): void {
    const position = (point: WritingPoint) => {
      const view = this.views[point.scene]
      view.markup.read()
      const result = view.markup.domPosition(point.offset)
      if (!result) throw new Error('Selection outside fixture prose.')
      return result
    }
    const a = position(anchor)
    const f = position(focus)
    const select = () => {
      this.root.focus({ preventScroll: true })
      this.editor.getSelection()!.setBaseAndExtent(a.node, a.offset, f.node, f.offset)
    }
    if (this.editor.writingViewport) this.editor.writingViewport.intent(select)
    else select()
  }

  private selectedRanges(): { index: number; range: Range }[] {
    const selected = this.editor.getSelection()
    if (!selected?.rangeCount) return []
    const original = selected.getRangeAt(0)
    return this.views.flatMap((view, index) => {
      if (view.root.hidden || !original.intersectsNode(view.root)) return []
      const range = this.editor.document.createRange()
      range.selectNodeContents(view.root)
      if (view.root.contains(original.startContainer)) range.setStart(original.startContainer, original.startOffset)
      if (view.root.contains(original.endContainer)) range.setEnd(original.endContainer, original.endOffset)
      return [{ index, range }]
    })
  }

  command(command: WritingCommand): void {
    this.capture()
    const selection = this.selection()
    this.commanding = true
    try {
      for (const { index, range } of this.selectedRanges().reverse()) {
        const selected = this.editor.getSelection()!
        selected.removeAllRanges()
        selected.addRange(range)
        if (command === 'wrapSelectionAsComment') this.editor.wrapSelectionAsComment(`comment-${index}`)
        else this.editor[command]()
        this.dirty.add(index)
      }
    } finally { this.commanding = false }
    this.capture()
    if (selection) this.restore(selection)
  }

  private beforeInput(event: InputEvent): void {
    if (this.composing || event.isComposing) return
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.inputType === 'historyUndo') this.undo()
      else this.redo()
      return
    }
    const ranges = this.selectedRanges()
    if (ranges.length > 1 && ['insertText', 'insertReplacementText', 'insertParagraph', 'insertLineBreak'].includes(event.inputType)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      this.replaceRanges(ranges, () => {
        if (event.inputType === 'insertParagraph') this.editor.document.execCommand('insertParagraph')
        else if (event.inputType === 'insertLineBreak') this.editor.document.execCommand('insertHTML', false, '<br>')
        else {
          const text = event.inputType === 'insertReplacementText' ? event.dataTransfer?.getData('text/plain') ?? event.data ?? '' : event.data ?? ''
          this.editor.document.execCommand('insertText', false, text)
        }
      })
      return
    }
    if (!event.inputType.startsWith('delete')) return
    const selection = this.editor.getSelection()
    if (selection?.isCollapsed && ranges.length === 1 && selection.anchorNode) {
      const view = this.views[ranges[0].index]
      view.markup.read()
      const offset = view.markup.position(selection.anchorNode, selection.anchorOffset)
      if ((event.inputType.endsWith('Backward') && offset === 0) ||
          (event.inputType.endsWith('Forward') && offset === view.state.text.length - 1)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    if (ranges.length < 2) return
    event.preventDefault()
    event.stopImmediatePropagation()
    this.replaceRanges(ranges)
  }

  private copy(event: ClipboardEvent): void {
    const ranges = this.selectedRanges()
    if (!ranges.length || !event.clipboardData) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', ranges.map(({ range }) => range.toString()).join('\n'))
    const container = this.editor.document.createElement('div')
    for (const { range } of ranges) container.append(range.cloneContents())
    clearWritingSpacing(container)
    event.clipboardData.setData('text/html', container.innerHTML)
  }

  private paste(event: ClipboardEvent): void {
    const ranges = this.selectedRanges()
    if (ranges.length < 2 || !event.clipboardData) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const transfer = event.clipboardData
    this.replaceRanges(ranges, () => {
      const html = transfer.getData('text/html')
      if (html) this.editor.document.execCommand('insertHTML', false, this.editor.sanitizePastedHtml(html))
      else this.editor.document.execCommand('insertText', false, transfer.getData('text/plain'))
    })
  }

  private replaceRanges(ranges: { index: number; range: Range }[], insert?: () => void): void {
    this.capture()
    this.commanding = true
    try {
      const start = ranges[0].range.cloneRange()
      start.collapse(true)
      for (const { index, range } of [...ranges].reverse()) {
        range.deleteContents()
        const root = this.views[index].root
        if (!root.textContent && !root.querySelector('img')) root.replaceChildren(this.editor.sanitizeSceneFragment('<p><br></p>'))
        this.dirty.add(index)
      }
      const first = this.views[ranges[0].index].root
      if (start.startContainer === first || !first.contains(start.startContainer)) {
        start.selectNodeContents(first.firstElementChild ?? first)
        start.collapse(true)
      }
      const selection = this.editor.getSelection()!
      selection.removeAllRanges()
      selection.addRange(start)
      insert?.()
    } finally { this.commanding = false }
    this.capture()
  }

  serialize() {
    this.capture()
    return this.views.map((view, index) => {
      if (!view.root.isConnected || !this.root.contains(view.root) || view.root.dataset.sceneId !== this.book.scenes[index].id) throw new Error('A live scene owner was detached or replaced.')
      const clone = view.root.cloneNode(true) as HTMLElement
      clearWritingSpacing(clone)
      clone.querySelectorAll('.nv-focus-block').forEach(node => node.classList.remove('nv-focus-block'))
      clone.querySelectorAll('[class=""]').forEach(node => node.removeAttribute('class'))
      clone.querySelectorAll('.nv-page').forEach(page => page.replaceWith(...page.childNodes))
      return { id: this.book.scenes[index].id, html: clone.innerHTML, text: clone.textContent ?? '' }
    })
  }

  scope(indices: number[]): void {
    if (this.composing) { this.pendingScope = indices; return }
    this.capture()
    this.savedSelection = this.selection() ?? this.savedSelection
    for (const [index, view] of this.views.entries()) view.root.hidden = !indices.includes(index)
    this.observer.takeRecords()
    if (this.savedSelection && indices.includes(this.savedSelection.anchor.scene) && indices.includes(this.savedSelection.focus.scene)) this.restore(this.savedSelection)
  }

  undo(): void { this.capture(); this.history.change(false) }
  redo(): void { this.capture(); this.history.change(true) }

  remoteInsert(scene: number, offset: number, text: string): void {
    this.capture()
    const state = this.views[scene].state
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(state.doc))
    const before = Y.encodeStateVector(state.doc)
    remote.getText('prose').insert(offset, text)
    Y.applyUpdate(state.doc, Y.encodeStateAsUpdate(remote, before), 'remote')
    remote.destroy()
  }

  samples(): number[] { return [...this.latencies] }
  sampleCount(): number { return this.latencies.length }
  sceneCount(): number { return this.root.querySelectorAll('[data-scene-id]').length }
  activeScene(): string | null {
    const selection = this.editor.getSelection()
    return scenePoint(this.root, selection?.focusNode ?? null, selection?.focusOffset ?? 0)?.scene.dataset.sceneId ?? null
  }

  inspect() {
    return { deltas: this.views.map(view => view.state.text.toDelta()),
      undoGroups: this.history.undoGroups.map(group => [...group]), redoGroups: this.history.redoGroups.map(group => [...group]) }
  }
}

window.installWriting = (book, optimized, scoped) => {
  const states = book.scenes.map(() => {
    const doc = new Y.Doc()
    const text = doc.getText('prose')
    return { doc, text, history: new Y.UndoManager(text, { trackedOrigins: new Set([writer]) }) }
  })
  const history = new CompoundHistory(states)
  window.writingPanes = Array.from(document.querySelectorAll('iframe'), frame => new ExperimentPane(frame.contentWindow as ExperimentEditor, book, history, optimized, scoped))
}
