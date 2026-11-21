export interface FragmentProbe {
  registeredFragment(node: Node): boolean
  select(start: number, startOffset: number, end?: number, endOffset?: number): void
  snapshot(): {
    html: string
    text: string
    anchor: { identity: number; paragraph: number; offset: number; owner: number | null }
    focus: { identity: number; paragraph: number; offset: number; owner: number | null }
    collapsed: boolean
    retained: boolean[]
    unowned: number
    unknownSections: number
    pages: number
  }
}

declare global { interface Window { writingFragmentProbe: FragmentProbe } }

export function installFragmentProbe(fragmented: boolean | null): void {
  const root = document.getElementById('editor')!
  const atoms = Array.from(root.childNodes)
  const originals = atoms
  const wrappers = new Set<Node>()
  const owners = new Map<Node, number>()
  const identities = new Map<Node, number>()
  const identify = (node: Node): void => {
    identities.set(node, identities.size)
    node.childNodes.forEach(identify)
  }
  atoms.forEach(identify)
  if (fragmented === null) owners.set(root, 0)
  else document.body.classList.add('page-view')
  for (const atom of fragmented === null ? [] : atoms) {
    const paper = document.createElement('div')
    paper.className = 'nv-page'
    wrappers.add(paper)
    root.appendChild(paper)
    if (fragmented) {
      const fragment = document.createElement('section')
      fragment.style.margin = '0'
      fragment.style.padding = '0'
      wrappers.add(fragment)
      owners.set(fragment, 0)
      paper.appendChild(fragment)
      fragment.appendChild(atom)
    } else { owners.set(paper, 0); paper.appendChild(atom) }
  }
  const owner = (node: Node | null): number | null => {
    for (let current = node; current; current = current.parentNode) {
      const value = owners.get(current)
      if (value !== undefined) return value
    }
    return null
  }
  const appendClean = (node: Node, destination: Node): void => {
    if (wrappers.has(node)) { node.childNodes.forEach(child => appendClean(child, destination)); return }
    const clone = node.cloneNode(false)
    destination.appendChild(clone)
    node.childNodes.forEach(child => appendClean(child, clone))
  }
  window.writingFragmentProbe = {
    registeredFragment: node => owners.has(node) && wrappers.has(node) && node.nodeName === 'SECTION',
    select(start, startOffset, end = start, endOffset = startOffset) {
      root.focus({ preventScroll: true })
      const text = (node: Node): Node => node.nodeType === Node.TEXT_NODE ? node : document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()!
      window.getSelection()!.setBaseAndExtent(text(originals[start]), startOffset, text(originals[end]), endOffset)
    },
    snapshot() {
      const selection = window.getSelection()!
      const paragraphs = Array.from(root.querySelectorAll('p'))
      const endpoint = (node: Node | null, offset: number) => ({ identity: node ? identities.get(node) ?? -1 : -1,
        paragraph: paragraphs.findIndex(paragraph => paragraph === node || paragraph.contains(node)), offset, owner: owner(node) })
      const clean = document.createElement('div')
      root.childNodes.forEach(node => appendClean(node, clean))
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let unowned = 0
      while (walker.nextNode()) if (owner(walker.currentNode) === null) unowned++
      return { html: clean.innerHTML, text: clean.textContent!,
        anchor: endpoint(selection.anchorNode, selection.anchorOffset), focus: endpoint(selection.focusNode, selection.focusOffset),
        collapsed: selection.isCollapsed, retained: originals.map(node => node.isConnected && root.contains(node)), unowned,
        unknownSections: Array.from(root.querySelectorAll('section')).filter(node => !wrappers.has(node)).length,
        pages: root.querySelectorAll('.nv-page').length }
    }
  }
}
