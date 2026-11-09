import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'
import { WritingPresentation } from './writingPresentation'

interface PageEditor extends EditorWindow {
  NovalistEditorState: { pageViewMutationObserver: MutationObserver | null; isComposing: boolean }
  schedulePageViewRepaginate(): void
}

function preserveSelection(editor: PageEditor, operation: () => void): void {
  const selection = editor.getSelection()
  const endpoint = (node: Node, offset: number): { node: Node; offset: number } => {
    if (node.nodeType !== 1 || !(node as Element).matches('[data-scene-id], .nv-page')) return { node, offset }
    const next = node.childNodes[offset]
    const child = next ?? node.childNodes[offset - 1]
    return child ? endpoint(child, next ? 0 : child.nodeType === 3 ? child.textContent!.length : child.childNodes.length) : { node, offset }
  }
  const a = selection?.anchorNode ? endpoint(selection.anchorNode, selection.anchorOffset) : null
  const f = selection?.focusNode ? endpoint(selection.focusNode, selection.focusOffset) : null
  const saved = a && f ? { anchor: a.node, anchorOffset: a.offset, focus: f.node, focusOffset: f.offset } : null
  try { operation() }
  finally { if (saved) selection!.setBaseAndExtent(saved.anchor, saved.anchorOffset, saved.focus, saved.focusOffset) }
}

function unwrapPages(root: HTMLElement, presentation: WritingPresentation): void {
  root.querySelectorAll('.nv-page').forEach(page => presentation.unwrap(page))
}

function paginateScene(editor: PageEditor, root: HTMLElement, presentation: WritingPresentation): void {
  unwrapPages(root, presentation)
  const blocks = Array.from(root.children) as HTMLElement[]
  const measuringPage = editor.document.createElement('div')
  measuringPage.className = 'nv-page'
  presentation.append(root, measuringPage)
  presentation.append(measuringPage, ...blocks)
  const budget = 48 * parseFloat(editor.getComputedStyle(root).fontSize)
  const heights = blocks.map(block => Math.max(1, block.offsetHeight))
  let page = editor.document.createElement('div')
  page.className = 'nv-page'
  presentation.append(root, page)
  let height = 0
  blocks.forEach((block, index) => {
    if (height + heights[index] > budget && page.childNodes.length) {
      page = editor.document.createElement('div')
      page.className = 'nv-page'
      presentation.append(root, page)
      height = 0
    }
    presentation.append(page, block)
    height += heights[index]
  })
  presentation.remove(measuringPage)
}

export function installScenePagination(editor: PageEditor, presentation: WritingPresentation): void {
  const root = editor.document.getElementById('editor')!
  const originalSetPageView = editor.setPageView.bind(editor)
  let enabled = false
  let pending = false
  const dirty = new Set<HTMLElement>()
  presentation.observe(root, records => {
    for (const record of records) {
      if (record.type === 'attributes') continue
      const node = record.target.nodeType === 1 ? record.target as HTMLElement : record.target.parentElement
      const scene = node?.closest<HTMLElement>('[data-scene-id]')
      if (scene) dirty.add(scene)
    }
    if (dirty.size) editor.schedulePageViewRepaginate()
  })
  const paginate = (all = true) => {
    if (!enabled || editor.NovalistEditorState.isComposing) return
    preserveSelection(editor, () => {
      root.querySelectorAll(':scope > .nv-page').forEach(page => presentation.unwrap(page))
      const scenes = all ? root.querySelectorAll<HTMLElement>('[data-scene-id]') : [...dirty]
      dirty.clear()
      for (const scene of scenes) paginateScene(editor, scene, presentation)
    })
  }
  editor.setPageView = value => {
    enabled = value
    originalSetPageView(value)
    editor.NovalistEditorState.pageViewMutationObserver?.disconnect()
    if (!enabled) {
      preserveSelection(editor, () => unwrapPages(root, presentation))
    }
  }
  editor.repaginatePageView = paginate
  editor.schedulePageViewRepaginate = () => {
    if (pending || !enabled) return
    pending = true
    editor.setTimeout(() => { pending = false; paginate(dirty.size === 0) }, 150)
  }
  root.addEventListener('input', () => editor.schedulePageViewRepaginate())
}
