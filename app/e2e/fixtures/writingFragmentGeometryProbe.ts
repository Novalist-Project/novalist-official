export function packFragmentGeometryProbe() {
  const root = document.getElementById('editor')!
  const nodes = Array.from(root.childNodes)
  const authored = root.innerHTML
  const fragments: HTMLElement[] = []
  document.body.classList.add('page-view')
  const em = parseFloat(getComputedStyle(root).fontSize)
  const range = document.createRange()
  const rect = (node: Node): DOMRect => { range.selectNode(node); return range.getBoundingClientRect() }
  const createFragment = (): HTMLElement => {
    const paper = document.createElement('div')
    paper.className = 'nv-page'
    const fragment = document.createElement('section')
    fragment.style.margin = '0'
    fragment.style.padding = '0'
    root.appendChild(paper)
    paper.appendChild(fragment)
    fragments.push(fragment)
    return fragment
  }
  const bounds = (fragment: HTMLElement) => {
    const paper = fragment.parentElement!
    const box = paper.getBoundingClientRect()
    const style = getComputedStyle(paper)
    const top = box.top + parseFloat(style.paddingTop)
    const bottom = box.bottom - parseFloat(style.paddingBottom)
    return { top, bottom, left: box.left + parseFloat(style.paddingLeft), right: box.right - parseFloat(style.paddingRight), contentHeight: bottom - top }
  }
  let fragment = createFragment()
  for (const node of nodes) {
    fragment.appendChild(node)
    const page = bounds(fragment)
    const fit = page.contentHeight <= em * 48 + 0.1 && Array.from(fragment.childNodes).every(child => {
      const box = rect(child)
      return box.top >= page.top && box.bottom <= page.bottom && box.left >= page.left && box.right <= page.right
    })
    if (!fit && fragment.childNodes.length > 1) {
      fragment = createFragment()
      fragment.appendChild(node)
    }
  }
  return { em, nodeCount: nodes.length, cleanExact: fragments.map(item => item.innerHTML).join('') === authored,
    connected: nodes.every(node => node.isConnected),
    orderExact: fragments.flatMap(item => Array.from(item.childNodes)).every((node, index) => node === nodes[index]),
    pages: fragments.map(item => ({ ...bounds(item), atoms: Array.from(item.childNodes, node => ({ index: nodes.indexOf(node), rect: rect(node).toJSON() })) })) }
}
