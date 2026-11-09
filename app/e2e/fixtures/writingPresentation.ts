type Consume = (records: MutationRecord[]) => void

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

  private move(nodes: Node[], parent: Node, operation: () => void): void {
    const targets = new Set([parent, ...nodes.flatMap(node => node.parentNode ? [node.parentNode] : [])])
    const moved = new Set(nodes)
    for (const [observer, consume] of this.observers) consume(contentRecords(observer.takeRecords()))
    try { operation() }
    finally {
      for (const [observer, consume] of this.observers) consume(contentRecords(observer.takeRecords()).filter(record =>
        record.type !== 'childList' || !targets.has(record.target) ||
        [...record.addedNodes, ...record.removedNodes].some(node => !moved.has(node))))
    }
  }

  append(parent: HTMLElement, ...nodes: Node[]): void {
    this.move(nodes, parent, () => parent.append(...nodes))
  }

  unwrap(page: Element): void {
    const parent = page.parentNode
    if (!parent) return
    const children = Array.from(page.childNodes)
    this.move([page, ...children], parent, () => page.replaceWith(...children))
  }

  remove(page: Element): void {
    const parent = page.parentNode
    if (parent) this.move([page], parent, () => page.remove())
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
