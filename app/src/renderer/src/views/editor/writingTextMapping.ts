export interface WritingTextPart { node: Node; start: number; text: string }
export interface WritingDomPoint { node: Node; offset: number }
export interface WritingTextMapping {
  parts(root: HTMLElement): WritingTextPart[]
  domPoint(root: HTMLElement, offset: number, affinity?: 'before' | 'after'): WritingDomPoint
  offset(root: HTMLElement, node: Node, offset: number): number
}

function parts(root: HTMLElement): WritingTextPart[] {
  const result: WritingTextPart[] = []
  let offset = 0
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? ''
      result.push({ node, start: offset, text })
      offset += text.length
      return
    }
    if (node.nodeType !== 1 || (node as Element).hasAttribute('data-editor-chrome')) return
    for (const child of node.childNodes) visit(child)
    if (node.nodeName === 'P' || node.nodeName === 'BR') {
      result.push({ node, start: offset, text: '\n' })
      offset++
    }
  }
  for (const child of root.childNodes) visit(child)
  return result
}

function domPoint(root: HTMLElement, offset: number, affinity: 'before' | 'after' = 'after'): WritingDomPoint {
  const text = parts(root)
  for (let index = 0; index < text.length; index++) {
    const part = text[index]
    const end = part.start + part.text.length
    if (offset > end || (offset === end && affinity === 'after' && text[index + 1]?.start === end)) continue
    if (part.node.nodeType === 3) return { node: part.node, offset: Math.max(0, offset - part.start) }
    if (offset <= part.start && part.node.nodeName === 'P') return { node: part.node, offset: part.node.childNodes.length }
    const parent = part.node.parentNode!
    return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, part.node) + (offset > part.start ? 1 : 0) }
  }
  return { node: root, offset: root.childNodes.length }
}

function offset(root: HTMLElement, node: Node, position: number): number {
  if (node !== root && !root.contains(node)) throw new Error('The writing position belongs to another scene.')
  const range = root.ownerDocument.createRange()
  range.selectNodeContents(root)
  range.setEnd(node, position)
  const fragment = root.ownerDocument.createElement('div')
  fragment.append(range.cloneContents())
  let length = parts(fragment).reduce((total, part) => total + part.text.length, 0)
  const parent = node.nodeType === 1 ? node as Element : node.parentElement
  if (parent !== root && parent?.closest('p')) length--
  return Math.max(0, length)
}

export const writingTextMapping: WritingTextMapping = { parts, domPoint, offset }
