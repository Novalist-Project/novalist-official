import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'
import { SceneProjection, type SceneEndpoint, type SceneSurface } from './writingSceneSurface'

interface FragmentLayoutEditor extends EditorWindow {
  NovalistEditorState: { pageViewEnabled: boolean; pageViewMutationObserver: MutationObserver | null }
  schedulePageViewRepaginate(): void
}

function endpoint(projection: SceneProjection, node: Node | null, offset: number, affinity: SceneEndpoint['affinity']): SceneEndpoint | null {
  const point = projection.locate(node, offset, affinity)
  if (!point || !projection.isFragment(point.node)) return point
  const next = point.node.childNodes[point.offset]
  const child = next ?? point.node.childNodes[point.offset - 1]
  return child ? { ...point, node: child, offset: next ? 0 : child.nodeType === 3 ? child.textContent!.length : child.childNodes.length } : point
}

export function isInlineFlow(node: Node, view: Window): boolean {
  if (node.nodeType !== 1) return true
  const display = view.getComputedStyle(node as Element).display
  return display === 'none' || display.startsWith('inline')
}

function atomGroups(scene: SceneSurface, view: Window): Node[][] {
  const groups: Node[][] = []
  let inline = false
  for (const node of scene.atoms()) {
    const nextInline = isInlineFlow(node, view)
    if (inline && nextInline) groups.at(-1)!.push(node)
    else groups.push([node])
    inline = nextInline
  }
  return groups
}

export function packSceneFragments(projection: SceneProjection, paged: boolean): void {
  const { root, presentation } = projection
  const view = root.ownerDocument.defaultView!
  const previousPages = projection.pageNodes()
  const scenes = projection.scenes.filter(scene => scene.visible)
  const groups = new Map(scenes.map(scene => [scene, atomGroups(scene, view)]))
  const layouts = new Map<SceneSurface, HTMLElement[]>()
  let page: HTMLElement | null = null
  let pageGroups: Node[][] = []
  const createPage = () => { page = projection.page(); pageGroups = [] }
  const fits = (): boolean => {
    const box = page!.getBoundingClientRect()
    const scale = box.width / page!.offsetWidth
    const style = view.getComputedStyle(page!)
    const top = box.top + parseFloat(style.paddingTop) * scale
    const bottom = top + 48 * parseFloat(view.getComputedStyle(root).fontSize) * scale
    const left = box.left + parseFloat(style.paddingLeft) * scale
    const right = box.right - parseFloat(style.paddingRight) * scale
    const range = root.ownerDocument.createRange()
    return pageGroups.every(group => group.every(node => {
      range.selectNode(node)
      return Array.from(range.getClientRects()).every(rect => rect.top >= top - 0.1 && rect.bottom <= bottom + 0.1 && rect.left >= left - 0.1 && rect.right <= right + 0.1)
    }))
  }
  for (const scene of scenes) {
    if (paged && !page) createPage()
    let fragment = projection.fragment(scene, paged ? page! : root, scene.fragments[0])
    const fragments = [fragment]
    layouts.set(scene, fragments)
    for (const group of groups.get(scene)!) {
      for (const node of group) presentation.append(fragment, node)
      if (!paged) continue
      pageGroups.push(group)
      if (pageGroups.length > 1 && !fits()) {
        createPage()
        const next = projection.fragment(scene, page!, scene.fragments[scene.fragments.indexOf(fragment) + 1])
        for (const node of group) presentation.append(next, node)
        if (!fragment.childNodes.length) fragments.pop()
        fragments.push(next)
        fragment = next
        pageGroups.push(group)
      }
    }
  }
  for (const [scene, fragments] of layouts) projection.commitFragments(scene, fragments)
  for (const old of previousPages) projection.removePage(old)
}

export function installFragmentLayout(editor: FragmentLayoutEditor, projection: SceneProjection, ready: () => boolean): { flush(): void; dispose(): void } {
  const { root } = projection
  let enabled = false
  let pending = false
  let timer = 0
  let disposed = false
  const flush = () => {
    if (disposed || !pending || !ready()) return
    pending = false
    const selected = editor.getSelection()
    const anchor = endpoint(projection, selected?.anchorNode ?? null, selected?.anchorOffset ?? 0, 'forward')
    const focus = endpoint(projection, selected?.focusNode ?? null, selected?.focusOffset ?? 0, 'backward')
    const wrapper = root.parentElement!
    const scroll = { top: wrapper.scrollTop, left: wrapper.scrollLeft }
    editor.NovalistEditorState.pageViewEnabled = enabled
    editor.document.body.classList.toggle('page-view', enabled)
    packSceneFragments(projection, enabled)
    if (anchor && focus) selected!.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
    wrapper.scrollTop = scroll.top
    wrapper.scrollLeft = scroll.left
  }
  editor.NovalistEditorState.pageViewMutationObserver?.disconnect()
  editor.setPageView = value => { enabled = value; pending = true; flush() }
  editor.repaginatePageView = () => { pending = true; flush() }
  editor.schedulePageViewRepaginate = () => {
    if (disposed || !enabled) return
    pending = true
    if (timer) return
    timer = editor.setTimeout(() => { timer = 0; flush() }, 150)
  }
  const observer = projection.presentation.observe(root, records => {
    if (records.some(record => projection.owner(record.target))) editor.schedulePageViewRepaginate()
  })
  return { flush, dispose() { disposed = true; pending = false; editor.clearTimeout(timer); timer = 0; observer.disconnect() } }
}
