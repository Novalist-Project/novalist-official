type Consume = (records: MutationRecord[]) => void
interface ChildChange { target: Node; added: Node[]; removed: Node[] }
interface AttributeChange { target: Element; name: string; before: string | null; after: string | null }
type Change = ChildChange | AttributeChange

export const writingSpacingAttributes = ['data-writing-flow-before', 'data-writing-flow-after'] as const

export function clearWritingSpacing(root: ParentNode): void {
  for (const name of writingSpacingAttributes) root.querySelectorAll(`[${name}]`).forEach(node => node.removeAttribute(name))
}

function matches(record: MutationRecord, change: Change, records: MutationRecord[], index: number): boolean {
  if (record.target !== change.target) return false
  if ('added' in change) return record.type === 'childList' && sameNodes(record.addedNodes, change.added) && sameNodes(record.removedNodes, change.removed)
  if (record.type !== 'attributes' || record.attributeName !== change.name || record.oldValue !== change.before) return false
  const later = records.slice(index + 1).find(item => item.type === 'attributes' && item.target === record.target && item.attributeName === change.name)
  return (later ? later.oldValue : change.target.getAttribute(change.name)) === change.after
}

function removals(nodes: Node[]): ChildChange[] {
  return nodes.flatMap(node => node.parentNode ? [{ target: node.parentNode, added: [], removed: [node] }] : [])
}

function sameNodes(actual: NodeList, expected: Node[]): boolean {
  return actual.length === expected.length && expected.every((node, index) => actual[index] === node)
}

export function authoredClass(value: string | null): string {
  return (value ?? '').split(/\s+/).filter(name => name && name !== 'nv-focus-block').join(' ')
}

export function contentRecords(records: MutationRecord[]): MutationRecord[] {
  return records.filter(record => record.type !== 'attributes' || record.attributeName !== 'class' ||
    authoredClass(record.oldValue) !== authoredClass((record.target as Element).getAttribute('class')))
}

export class WritingPresentation {
  private readonly observers = new Map<MutationObserver, Consume>()

  observe(root: HTMLElement, consume: Consume): MutationObserver {
    const observer = new MutationObserver(records => consume(contentRecords(records)))
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true })
    this.observers.set(observer, consume)
    return observer
  }

  private move(expected: Change[], operation: () => void): void {
    for (const [observer, consume] of this.observers) consume(contentRecords(observer.takeRecords()))
    try { operation() }
    finally {
      for (const [observer, consume] of this.observers) {
        let next = 0
        const records = contentRecords(observer.takeRecords())
        const authored = records.filter((record, index) => {
          const change = expected[next]
          if (!change || !matches(record, change, records, index)) return true
          next++
          return false
        })
        consume(next === expected.length ? authored : records)
      }
    }
  }

  spacing(target: Element, edge: 'before' | 'after', value: number | null): void {
    if (edge !== 'before' && edge !== 'after') throw new Error('Invalid presentation edge.')
    if (value !== null && !Number.isFinite(value)) throw new Error('Invalid presentation spacing.')
    const name = edge === 'before' ? writingSpacingAttributes[0] : writingSpacingAttributes[1]
    const before = target.getAttribute(name)
    const after = value === null ? null : String(value)
    if (before === after) return
    this.move([{ target, name, before, after }], () => {
      if (after === null) target.removeAttribute(name)
      else target.setAttribute(name, after)
    })
  }

  append(parent: HTMLElement, ...nodes: Node[]): void {
    this.move([...removals(nodes), { target: parent, added: nodes, removed: [] }], () => parent.append(...nodes))
  }

  unwrap(page: Element): void {
    const parent = page.parentNode
    if (!parent) return
    const children = Array.from(page.childNodes)
    this.move([...removals(children), { target: parent, added: children, removed: [page] }], () => page.replaceWith(...children))
  }

  remove(page: Element): void {
    const parent = page.parentNode
    if (parent) this.move([{ target: parent, added: [], removed: [page] }], () => page.remove())
  }
}

export function scenePoint(root: HTMLElement, node: Node | null, offset: number): { scene: HTMLElement; node: Node; offset: number } | null {
  if (!node || !root.contains(node)) return null
  if (node === root) {
    const next = root.childNodes[offset] as HTMLElement | undefined
    const previous = root.childNodes[offset - 1] as HTMLElement | undefined
    const scene = next ?? previous
    if (!scene?.matches?.('[data-scene-id]')) return null
    return { scene, node: scene, offset: next ? 0 : scene.childNodes.length }
  }
  const element = node.nodeType === 1 ? node as Element : node.parentElement
  const scene = element?.closest<HTMLElement>('[data-scene-id]')
  return scene ? { scene, node, offset } : null
}
