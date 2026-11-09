import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'

interface PageEditor extends EditorWindow {
  NovalistEditorState: { pageViewMutationObserver: MutationObserver | null; isComposing: boolean }
  schedulePageViewRepaginate(): void
}

function unwrapPages(root: HTMLElement): void {
  root.querySelectorAll('.nv-page').forEach(page => page.replaceWith(...page.childNodes))
}

function paginateScene(editor: PageEditor, root: HTMLElement): void {
  unwrapPages(root)
  const blocks = Array.from(root.children) as HTMLElement[]
  const measuringPage = editor.document.createElement('div')
  measuringPage.className = 'nv-page'
  root.append(measuringPage)
  measuringPage.append(...blocks)
  const budget = 48 * parseFloat(editor.getComputedStyle(root).fontSize)
  const heights = blocks.map(block => Math.max(1, block.offsetHeight))
  let page = editor.document.createElement('div')
  page.className = 'nv-page'
  root.append(page)
  let height = 0
  blocks.forEach((block, index) => {
    if (height + heights[index] > budget && page.childNodes.length) {
      page = editor.document.createElement('div')
      page.className = 'nv-page'
      root.append(page)
      height = 0
    }
    page.append(block)
    height += heights[index]
  })
  measuringPage.remove()
}

export function installScenePagination(editor: PageEditor): void {
  const root = editor.document.getElementById('editor')!
  const originalSetPageView = editor.setPageView.bind(editor)
  let enabled = false
  let pending = false
  const dirty = new Set<HTMLElement>()
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const node = record.target.nodeType === 1 ? record.target as HTMLElement : record.target.parentElement
      const scene = node?.closest<HTMLElement>('[data-scene-id]')
      if (scene) dirty.add(scene)
    }
    if (dirty.size) editor.schedulePageViewRepaginate()
  })
  observer.observe(root, { subtree: true, childList: true, characterData: true })
  const paginate = (all = true) => {
    if (!enabled || editor.NovalistEditorState.isComposing) return
    const selection = editor.getSelection()
    const saved = selection?.anchorNode && selection.focusNode ? {
      anchor: selection.anchorNode, anchorOffset: selection.anchorOffset,
      focus: selection.focusNode, focusOffset: selection.focusOffset
    } : null
    root.querySelectorAll(':scope > .nv-page').forEach(page => page.replaceWith(...page.childNodes))
    const scenes = all ? root.querySelectorAll<HTMLElement>('[data-scene-id]') : dirty
    for (const scene of scenes) paginateScene(editor, scene)
    dirty.clear()
    observer.takeRecords()
    if (saved) selection!.setBaseAndExtent(saved.anchor, saved.anchorOffset, saved.focus, saved.focusOffset)
  }
  editor.setPageView = value => {
    enabled = value
    originalSetPageView(value)
    editor.NovalistEditorState.pageViewMutationObserver?.disconnect()
    if (enabled) paginate()
    else unwrapPages(root)
  }
  editor.repaginatePageView = paginate
  editor.schedulePageViewRepaginate = () => {
    if (pending || !enabled) return
    pending = true
    editor.setTimeout(() => { pending = false; paginate(dirty.size === 0) }, 150)
  }
  root.addEventListener('input', () => editor.schedulePageViewRepaginate())
}
