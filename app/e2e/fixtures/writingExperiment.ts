import * as Y from 'yjs'
import { SceneMarkup } from '../../src/renderer/src/collaboration/sceneMarkup'
import { updateRichText } from '../../src/renderer/src/collaboration/richText'
import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'
import type { FixtureBook } from './writingBook'
import type { WritingCommand, WritingPane, WritingPoint } from './writingContract'

interface SceneDocument { doc: Y.Doc; text: Y.Text; history: Y.UndoManager }
interface SceneView { root: HTMLElement; markup: SceneMarkup; state: SceneDocument }
interface RelativePoint { scene: number; position: Y.RelativePosition }
interface LogicalSelection { anchor: RelativePoint; focus: RelativePoint }
interface ExperimentEditor extends EditorWindow { wrapSelectionAsComment(id: string): string | null }

const writer = {}

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

  constructor(private readonly editor: ExperimentEditor, private readonly book: FixtureBook, private readonly history: CompoundHistory) {
    this.root = editor.document.getElementById('editor')!
    this.root.replaceChildren()
    this.views = book.scenes.map((scene, index) => {
      const root = editor.document.createElement('section')
      root.dataset.sceneId = scene.id
      root.append(editor.sanitizeSceneFragment(scene.html))
      this.root.append(root)
      const markup = new SceneMarkup({ document: editor.document,
        sanitizeSceneFragment: html => editor.sanitizeSceneFragment(html),
        toDisplayImages: content => editor.toDisplayImages(content) }, root)
      const state = history.scenes[index]
      if (!state.text.length) state.doc.transact(() => updateRichText(state.text, markup.read()))
      else markup.render(state.text.toDelta())
      state.text.observe(() => { if (!this.applying && !this.composing) this.render(index) })
      return { root, markup, state }
    })
    this.observer = new MutationObserver(records => this.markDirty(records))
    this.observer.observe(this.root, { subtree: true, childList: true, characterData: true, attributes: true })
    this.installEvents()
  }

  private installEvents(): void {
    this.root.addEventListener('input', event => {
      const start = event.timeStamp
      this.editor.requestAnimationFrame(() => this.latencies.push(this.editor.performance.now() - start))
      if (!this.composing) this.capture()
    })
    this.root.addEventListener('beforeinput', event => this.beforeInput(event), true)
    this.root.addEventListener('copy', event => this.copy(event))
    this.root.addEventListener('compositionstart', () => { this.composing = true })
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
      const index = this.views.findIndex(view => view.root === root)
      if (index >= 0) this.dirty.add(index)
    }
  }

  capture(): void {
    if (this.composing || this.applying || this.commanding) return
    this.markDirty(this.observer.takeRecords())
    this.applying = true
    try { this.history.capture(this.views, [...this.dirty]) }
    finally { this.applying = false; this.dirty.clear() }
  }

  private render(index: number): void {
    const saved = this.selection()
    const view = this.views[index]
    view.markup.render(view.state.text.toDelta())
    this.observer?.takeRecords()
    if (saved) this.restore(saved)
  }

  private point(node: Node, offset: number): RelativePoint | null {
    const scene = this.views.findIndex(view => view.root.contains(node))
    if (scene < 0) return null
    const view = this.views[scene]
    view.markup.read()
    const index = view.markup.position(node, offset)
    return index === null ? null : { scene, position: Y.createRelativePositionFromTypeIndex(view.state.text, index) }
  }

  private selection(): LogicalSelection | null {
    const selection = this.editor.getSelection()
    if (!selection?.anchorNode || !selection.focusNode) return null
    const anchor = this.point(selection.anchorNode, selection.anchorOffset)
    const focus = this.point(selection.focusNode, selection.focusOffset)
    return anchor && focus ? { anchor, focus } : null
  }

  private restore(selection: LogicalSelection): void {
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
    this.root.focus({ preventScroll: true })
    this.editor.getSelection()!.setBaseAndExtent(a.node, a.offset, f.node, f.offset)
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
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.inputType === 'historyUndo') this.undo()
      else this.redo()
      return
    }
    if (event.isComposing || !event.inputType.startsWith('delete')) return
    const ranges = this.selectedRanges()
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
    for (const { index, range } of ranges.reverse()) {
      range.deleteContents()
      const root = this.views[index].root
      if (!root.textContent && !root.querySelector('img')) root.replaceChildren(this.editor.sanitizeSceneFragment('<p><br></p>'))
      this.dirty.add(index)
    }
    this.capture()
  }

  private copy(event: ClipboardEvent): void {
    const ranges = this.selectedRanges()
    if (!ranges.length || !event.clipboardData) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', ranges.map(({ range }) => range.toString()).join('\n'))
    const container = this.editor.document.createElement('div')
    for (const { range } of ranges) container.append(range.cloneContents())
    event.clipboardData.setData('text/html', container.innerHTML)
  }

  serialize() {
    this.capture()
    return this.views.map((view, index) => {
      const clone = view.root.cloneNode(true) as HTMLElement
      clone.querySelectorAll('.nv-focus-block').forEach(node => node.classList.remove('nv-focus-block'))
      clone.querySelectorAll('[class=""]').forEach(node => node.removeAttribute('class'))
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
    const node = this.editor.getSelection()?.focusNode
    return this.views.find(view => node && view.root.contains(node))?.root.dataset.sceneId ?? null
  }
}

window.installWriting = book => {
  const states = book.scenes.map(() => {
    const doc = new Y.Doc()
    const text = doc.getText('prose')
    return { doc, text, history: new Y.UndoManager(text, { trackedOrigins: new Set([writer]) }) }
  })
  const history = new CompoundHistory(states)
  window.writingPanes = Array.from(document.querySelectorAll('iframe'), frame => new ExperimentPane(frame.contentWindow as ExperimentEditor, book, history))
}
