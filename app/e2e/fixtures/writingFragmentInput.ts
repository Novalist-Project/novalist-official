import { SceneProjection, type SceneSurface } from './writingSceneSurface'
import { isInlineFlow } from './writingFragmentLayout'

interface ParagraphIntent {
  event: InputEvent
  scene: SceneSurface
  node: Text
  offset: number
  value: string
  fragment: HTMLElement
  parent: HTMLElement
  siblings: Node[]
  attributes: [string, string][]
  atoms: Node[]
  logicalFragments: { fragment: HTMLElement; atoms: Node[] }[]
  boundary: Node | null
  existingBreaks: Set<Element>
}

const sameNodes = (actual: NodeListOf<ChildNode>, expected: Node[]): boolean => actual.length === expected.length && expected.every((node, index) => actual[index] === node)

function authoredParagraph(element: HTMLElement, fragment: HTMLElement, next: Node | null, boundary: Node | null = null): void {
  const document = fragment.ownerDocument
  const selection = document.defaultView!.getSelection()!
  const anchor = selection.anchorNode!, focus = selection.focusNode!
  const anchorOffset = selection.anchorOffset, focusOffset = selection.focusOffset
  const paragraph = document.createElement('div')
  const children = Array.from(element.childNodes)
  const boundaryIndex = boundary ? children.indexOf(boundary as ChildNode) : -1
  const retained = boundaryIndex < 0 ? children.length : boundaryIndex
  while (element.firstChild) paragraph.appendChild(element.firstChild)
  fragment.insertBefore(paragraph, next)
  for (const node of children.slice(retained)) fragment.insertBefore(node, next)
  element.remove()
  const endpoint = (node: Node, offset: number): [Node, number] => node !== element ? [node, offset]
    : offset <= retained ? [paragraph, offset]
      : [fragment, Array.from(fragment.childNodes).indexOf(paragraph) + 1 + offset - retained]
  selection.setBaseAndExtent(...endpoint(anchor, anchorOffset), ...endpoint(focus, focusOffset))
}

export function installFragmentInput(projection: SceneProjection): { dispose(): void } {
  const { root } = projection
  const document = root.ownerDocument
  const view = document.defaultView!
  let intent: ParagraphIntent | null = null
  const delivered: MutationRecord[] = []
  const observer = new view.MutationObserver(records => { if (intent) delivered.push(...records) })
  observer.observe(root, { childList: true, characterData: true, subtree: true })
  const retire = () => { intent = null; delivered.length = 0; observer.takeRecords() }
  const before = (event: InputEvent) => {
    retire()
    const selection = view.getSelection()
    const node = selection?.anchorNode
    if (event.defaultPrevented || event.isComposing || event.inputType !== 'insertParagraph' || !selection?.isCollapsed || node?.nodeType !== 3) return
    const fragment = node.parentElement!
    const scene = projection.owner(fragment)
    if (!scene || !projection.isFragment(fragment)) return
    const logical = scene.atoms()
    const following = logical.slice(logical.indexOf(node) + 1)
    const boundary = following.find(child => {
      if (child.nodeType !== 1) return false
      const style = view.getComputedStyle(child as Element)
      if (style.display === 'none') return false
      if (style.display === 'contents' || ['absolute', 'fixed'].includes(style.position) || (style.cssFloat && style.cssFloat !== 'none')) projection.fail('Unsupported raw paragraph outer flow')
      return !isInlineFlow(child, view)
    }) ?? null
    const captured: ParagraphIntent = { event, scene, node: node as Text, offset: selection.anchorOffset, value: node.textContent!, fragment,
      parent: fragment.parentElement!, siblings: Array.from(fragment.parentElement!.childNodes), atoms: Array.from(fragment.childNodes),
      attributes: Array.from(fragment.attributes, attribute => [attribute.name, attribute.value]), boundary,
      logicalFragments: scene.fragments.map(fragment => ({ fragment, atoms: Array.from(fragment.childNodes) })), existingBreaks: new Set(root.querySelectorAll('br')) }
    intent = captured
    view.queueMicrotask(() => { if (intent === captured && event.defaultPrevented) retire() })
  }
  const input = (event: InputEvent) => {
    const captured = intent
    const records = [...delivered, ...observer.takeRecords()]
    retire()
    if (!captured || captured.event.defaultPrevented || event.inputType !== captured.event.inputType) return
    const { scene, node, offset, value, fragment, parent, siblings, attributes, atoms, logicalFragments, boundary, existingBreaks } = captured
    if (scene.fragments.length !== logicalFragments.length || logicalFragments.some((item, index) => item.fragment !== scene.fragments[index]
      || (item.fragment !== fragment && !sameNodes(item.fragment.childNodes, item.atoms)))) projection.fail('Native paragraph changed unrelated logical fragment topology')
    const index = atoms.indexOf(node)
    const preceding = atoms.slice(0, index)
    const following = atoms.slice(index + 1)
    if (sameNodes(parent.childNodes, siblings)) {
      const addedInside = Array.from(fragment.childNodes).filter(child => !atoms.includes(child))
      const candidate = addedInside[0]
      if (candidate?.nodeName !== 'SECTION') return
      const element = candidate as HTMLElement
      const br = element.firstElementChild
      const fresh = records.some(record => record.target === fragment && Array.from(record.addedNodes).includes(element))
      const freshBreak = br && !existingBreaks.has(br) && !records.some(record => Array.from(record.removedNodes).includes(br))
      if (offset !== 0 || addedInside.length !== 1 || candidate !== node.previousSibling || !fresh || !freshBreak
        || element.attributes.length !== attributes.length || !attributes.every(([name, value]) => element.getAttribute(name) === value)
        || element.childNodes.length !== 1 || br.tagName !== 'BR' || br.attributes.length || node.data !== value
        || !sameNodes(fragment.childNodes, [...preceding, element, node, ...following])) projection.fail('Unsupported native nested fragment paragraph topology')
      authoredParagraph(element, fragment, node)
      scene.atoms()
      return
    }
    const added = Array.from(parent.childNodes).filter(child => !siblings.includes(child))
    const candidate = added[0]
    const start = offset === 0
    const knownMutation = records.some(record => record.target === parent && Array.from(record.addedNodes).includes(candidate))
    const element = candidate?.nodeType === 1 ? candidate as HTMLElement : null
    const shape = element?.tagName === 'SECTION' && candidate === (start ? fragment.previousSibling : fragment.nextSibling)
      && element.attributes.length === attributes.length && attributes.every(([name, value]) => element.getAttribute(name) === value)
    const prefix = fragment.lastChild
    const atEnd = offset === value.length
    const nativeBreak = element?.firstElementChild
    const endChildren = nativeBreak?.tagName === 'BR' && !existingBreaks.has(nativeBreak) && !nativeBreak.attributes.length ? [nativeBreak, ...following] : following
    const split = shape && (start
      ? element.childNodes.length === 1 && nativeBreak?.tagName === 'BR' && !existingBreaks.has(nativeBreak) && !nativeBreak.attributes.length
        && sameNodes(fragment.childNodes, atoms) && node.data === value
      : atEnd
        ? sameNodes(fragment.childNodes, [...preceding, node]) && node.data === value && sameNodes(element.childNodes, endChildren)
        : prefix?.nodeType === 3 && prefix.textContent === value.slice(0, offset) && sameNodes(fragment.childNodes, [...preceding, prefix])
          && node.data === value.slice(offset) && sameNodes(element.childNodes, [node, ...following]))
    if (added.length !== 1 || !knownMutation || !split || projection.owner(fragment) !== scene || siblings.some(sibling => sibling.parentNode !== parent)) {
      projection.fail('Unsupported native fragment paragraph topology')
    }
    authoredParagraph(element, fragment, start ? fragment.firstChild : null, start ? null : boundary)
    scene.atoms()
  }
  root.addEventListener('beforeinput', before, true)
  root.addEventListener('input', input, true)
  return { dispose() { retire(); observer.disconnect(); root.removeEventListener('beforeinput', before, true); root.removeEventListener('input', input, true) } }
}
