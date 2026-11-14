export interface CommentPoint { node: Node; offset: number }
interface SavedPoint extends CommentPoint { value: string | null; after: Node | null; before: Node | null }

export class CommentBookmark {
  private readonly anchor: SavedPoint
  private readonly focus: SavedPoint

  constructor(private readonly selection: Selection) {
    const save = (node: Node, offset: number): SavedPoint => ({ node, offset,
      value: node.nodeType === 3 ? node.textContent : null,
      after: node.childNodes[offset] ?? null, before: node.childNodes[offset - 1] ?? null })
    this.anchor = save(selection.anchorNode!, selection.anchorOffset)
    this.focus = save(selection.focusNode!, selection.focusOffset)
  }

  split(original: Text, offset: number, suffix: Text, forward: boolean): void {
    for (const point of [this.anchor, this.focus]) {
      if (point.node !== original) continue
      if (point.offset > offset || (forward && point.offset === offset)) {
        point.node = suffix
        point.offset -= offset
      }
      point.value = point.node.textContent
    }
  }

  restore(fallback: (end: 'anchor' | 'focus', affinity: 'forward' | 'backward') => CommentPoint | null): void {
    const resolve = (point: SavedPoint, end: 'anchor' | 'focus'): CommentPoint | null => {
      if (point.node.isConnected) {
        if (point.value !== null && point.node.textContent === point.value) return point
        if (point.value === null) {
          if (point.offset === 0) return { node: point.node, offset: 0 }
          if (!point.after) return { node: point.node, offset: point.node.childNodes.length }
          if (point.after?.parentNode === point.node) return { node: point.node, offset: Array.from(point.node.childNodes).indexOf(point.after as ChildNode) }
          if (point.before?.parentNode === point.node) return { node: point.node, offset: Array.from(point.node.childNodes).indexOf(point.before as ChildNode) + 1 }
          if (!point.node.childNodes.length) return { node: point.node, offset: 0 }
        }
      }
      return fallback(end, point.offset === 0 ? 'forward' : 'backward')
    }
    const anchor = resolve(this.anchor, 'anchor'), focus = resolve(this.focus, 'focus')
    if (anchor && focus) this.selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
  }
}

function nextAfter(node: Node, boundary: Node): Node | null {
  while (node !== boundary) {
    if (node.nextSibling) return node.nextSibling
    if (!node.parentNode) return null
    node = node.parentNode
  }
  return null
}

export function wrapCommentLeaves(range: Range, id: string, bookmark: CommentBookmark): number {
  if (range.collapsed) return 0
  const boundary = range.commonAncestorContainer
  const leaves: { node: Node; start: number; end: number }[] = []
  let node: Node | null = range.startContainer.nodeType === 3 ? range.startContainer
    : range.startContainer.childNodes[range.startOffset] ?? nextAfter(range.startContainer, boundary)
  while (node && range.comparePoint(node, 0) !== 1) {
    if (node.nodeType === 3) {
      const start = node === range.startContainer ? range.startOffset : 0
      const end = node === range.endContainer ? range.endOffset : node.textContent!.length
      if (end > start) leaves.push({ node, start, end })
    } else if (node.nodeType === 1 && ['IMG', 'BR', 'HR'].includes(node.nodeName) && range.intersectsNode(node)) {
      const index = Array.from(node.parentNode!.childNodes).indexOf(node as ChildNode)
      if (range.comparePoint(node.parentNode!, index) === 0 && range.comparePoint(node.parentNode!, index + 1) === 0) leaves.push({ node, start: 0, end: 0 })
    }
    node = node.firstChild ?? nextAfter(node, boundary)
  }
  let following: HTMLElement | null = null
  let count = 0
  for (const leaf of leaves.reverse()) {
    let selected = leaf.node
    if (selected.nodeType === 3) {
      const text = selected as Text
      if (leaf.end < text.length) bookmark.split(text, leaf.end, text.splitText(leaf.end), false)
      if (leaf.start) {
        selected = text.splitText(leaf.start)
        bookmark.split(text, leaf.start, selected as Text, true)
      }
    }
    if (selected.nextSibling === following && following) following.prepend(selected)
    else {
      following = range.startContainer.ownerDocument!.createElement('span')
      following.className = 'nv-comment'
      following.setAttribute('data-comment-id', id)
      selected.parentNode!.insertBefore(following, selected)
      following.append(selected)
      count++
    }
  }
  return count
}
