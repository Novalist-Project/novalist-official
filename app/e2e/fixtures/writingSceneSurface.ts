import { WritingPresentation } from './writingPresentation'

export interface SceneSurface {
  readonly sceneId: string
  readonly fragments: readonly HTMLElement[]
  readonly visible: boolean
  atoms(): readonly Node[]
  topLevelBoundary(node: Node, offset: number): number | null
  insertBefore(node: Node, next: Node | null): void
  remove(node: Node): void
}

export interface SceneEndpoint {
  scene: SceneSurface
  node: Node
  offset: number
  affinity: 'forward' | 'backward'
}

export interface SceneSlice { scene: SceneSurface; ranges: Range[] }

class LiveSceneSurface implements SceneSurface {
  readonly fragments: HTMLElement[] = []
  visible = true

  constructor(readonly sceneId: string, private readonly projection: SceneProjection, readonly canonical: HTMLElement) {}

  atoms(): Node[] {
    return this.fragments.flatMap(fragment => Array.from(fragment.childNodes, node => {
      this.projection.remember(this, node)
      return node
    }))
  }

  topLevelBoundary(node: Node, offset: number): number | null {
    let first = 0
    for (const fragment of this.fragments) {
      if (fragment === node) return offset >= 0 && offset <= fragment.childNodes.length ? first + offset : null
      first += fragment.childNodes.length
    }
    return null
  }

  insertBefore(node: Node, next: Node | null): void {
    const fragment = next ? this.fragments.find(owner => next.parentNode === owner) : this.fragments.at(-1)
    if (!fragment) throw new Error('Missing logical scene insertion owner')
    this.projection.remember(this, node)
    fragment.insertBefore(node, next)
  }

  remove(node: Node): void {
    if (!this.fragments.some(fragment => node.parentNode === fragment)) throw new Error('Removal outside logical scene atoms')
    this.projection.remember(this, node)
    node.parentNode!.removeChild(node)
  }
}

export class SceneProjection {
  readonly scenes: SceneSurface[] = []
  readonly hidden: HTMLElement
  private fragmentOwners = new WeakMap<Node, LiveSceneSurface>()
  private atomOwners = new WeakMap<Node, SceneSurface>()
  private readonly pages = new Set<Node>()
  private failure: Error | null = null

  constructor(readonly root: HTMLElement, readonly presentation = new WritingPresentation()) {
    this.hidden = root.ownerDocument.createElement('div')
    this.hidden.hidden = true
    this.presentation.append(root, this.hidden)
  }

  create(sceneId: string, fragment: HTMLElement): SceneSurface {
    if (this.scenes.some(scene => scene.sceneId === sceneId)) throw new Error('Duplicate logical scene identity')
    const scene = new LiveSceneSurface(sceneId, this, fragment)
    this.register(scene, fragment)
    this.scenes.push(scene)
    scene.atoms()
    return scene
  }

  private register(scene: LiveSceneSurface, fragment: HTMLElement): void {
    fragment.dataset.sceneId = scene.sceneId
    fragment.dataset.writingFragment = ''
    fragment.style.margin = '0'
    fragment.style.padding = '0'
    this.fragmentOwners.set(fragment, scene)
    scene.fragments.push(fragment)
  }

  fragment(scene: SceneSurface, parent: HTMLElement, before?: HTMLElement): HTMLElement {
    const owner = this.scenes.find(value => value === scene)
    if (!(owner instanceof LiveSceneSurface)) throw new Error('Unknown logical scene')
    const fragment = this.root.ownerDocument.createElement('section')
    this.register(owner, fragment)
    if (before) {
      const index = owner.fragments.indexOf(before)
      if (index < 0) throw new Error('Unknown fragment layout boundary')
      owner.fragments.pop()
      owner.fragments.splice(index, 0, fragment)
    }
    this.presentation.append(parent, fragment)
    return fragment
  }

  page(): HTMLElement {
    const page = this.root.ownerDocument.createElement('div')
    page.className = 'nv-page'
    this.pages.add(page)
    this.presentation.append(this.root, page)
    return page
  }

  remember(scene: SceneSurface, node: Node): void { this.atomOwners.set(node, scene) }
  isFragment(node: Node): boolean { return this.fragmentOwners.has(node) }
  isPage(node: Node): boolean { return this.pages.has(node) }
  pageNodes(): HTMLElement[] { return [...this.pages] as HTMLElement[] }
  fail(message: string): never { this.failure = new Error(message); throw this.failure }

  assertTopology(): void {
    if (this.failure) throw this.failure
    for (const node of this.root.childNodes) {
      if (node === this.hidden || this.isFragment(node)) continue
      if (!this.isPage(node) || Array.from(node.childNodes).some(child => !this.isFragment(child))) this.fail('Unowned node at the scene presentation boundary')
    }
  }

  commitFragments(scene: SceneSurface, fragments: HTMLElement[]): void {
    if (!(scene instanceof LiveSceneSurface) || !fragments.length || fragments.some(fragment => this.fragmentOwners.get(fragment) !== scene)) throw new Error('Invalid fragment layout commit')
    const original = scene.canonical
    const first = fragments[0]
    if (original !== first) {
      if (original.childNodes.length) throw new Error('Layout left authored nodes in the original fragment')
      for (const node of Array.from(first.childNodes)) this.presentation.append(original, node)
      this.presentation.insertBefore(first.parentElement!, original, first)
      fragments[0] = original
    }
    for (const retired of scene.fragments) if (!fragments.includes(retired)) {
      if (retired.childNodes.length) throw new Error('Layout cannot discard nonempty fragments')
      this.presentation.remove(retired)
      this.fragmentOwners.delete(retired)
    }
    scene.fragments.splice(0, scene.fragments.length, ...fragments)
  }

  removePage(page: HTMLElement): void {
    if (!this.pages.has(page) || page.childNodes.length) throw new Error('Layout cannot discard a nonempty or unregistered page')
    this.presentation.remove(page)
    this.pages.delete(page)
  }

  owner(node: Node | null): SceneSurface | null {
    for (let current = node; current; current = current.parentNode) {
      const scene = this.fragmentOwners.get(current)
      if (scene) return scene
    }
    for (let current = node; current; current = current.parentNode) {
      const scene = this.atomOwners.get(current)
      if (scene) return scene
    }
    return null
  }

  locate(node: Node | null, offset: number, affinity: SceneEndpoint['affinity'] = 'forward'): SceneEndpoint | null {
    if (!node || !this.root.contains(node)) return null
    const scene = this.owner(node)
    if (scene) return scene.visible ? { scene, node, offset, affinity } : null
    if (node !== this.root && !this.pages.has(node)) return null
    const children = Array.from(node.childNodes)
    const following = children.slice(offset).map(child => ({ child, end: false }))
    const preceding = children.slice(0, offset).reverse().map(child => ({ child, end: true }))
    for (const { child, end } of affinity === 'forward' ? [...following, ...preceding] : [...preceding, ...following]) {
      const point = this.edge(child, end, affinity)
      if (point) return point
    }
    return null
  }

  private edge(node: Node, end: boolean, affinity: SceneEndpoint['affinity']): SceneEndpoint | null {
    const scene = this.owner(node)
    if (scene) return scene.visible ? { scene, node, offset: end ? node.nodeType === 3 ? node.textContent!.length : node.childNodes.length : 0, affinity } : null
    const children = Array.from(node.childNodes)
    for (const child of end ? children.reverse() : children) {
      const point = this.edge(child, end, affinity)
      if (point) return point
    }
    return null
  }

  slices(original: Range): SceneSlice[] {
    const start = this.locate(original.startContainer, original.startOffset)
    const end = original.collapsed ? start : this.locate(original.endContainer, original.endOffset, 'backward')
    if (!start || !end) return []
    const normalized = this.root.ownerDocument.createRange()
    normalized.setStart(start.node, start.offset)
    normalized.setEnd(end.node, end.offset)
    if (original.collapsed) return [{ scene: start.scene, ranges: [normalized] }]
    return this.scenes.filter(scene => scene.visible).flatMap(scene => {
      const ranges = scene.fragments.filter(fragment => normalized.intersectsNode(fragment)).map(fragment => {
        const range = this.root.ownerDocument.createRange()
        range.selectNodeContents(fragment)
        if (fragment.contains(start.node)) range.setStart(start.node, start.offset)
        if (fragment.contains(end.node)) range.setEnd(end.node, end.offset)
        return range
      }).filter(range => !range.collapsed)
      return ranges.length ? [{ scene, ranges }] : []
    })
  }

  visible(scene: SceneSurface, visible: boolean): void {
    const owner = this.scenes.find(value => value === scene)
    if (!(owner instanceof LiveSceneSurface)) throw new Error('Unknown logical scene')
    owner.visible = visible
    for (const fragment of owner.fragments) this.presentation.append(visible ? this.root : this.hidden, fragment)
  }

  clone(scene: SceneSurface): HTMLElement {
    this.assertTopology()
    const output = this.root.ownerDocument.createElement('div')
    const append = (node: Node, destination: Node): void => {
      if (this.isFragment(node) || this.isPage(node)) { node.childNodes.forEach(child => append(child, destination)); return }
      const clone = node.cloneNode(false)
      destination.appendChild(clone)
      node.childNodes.forEach(child => append(child, clone))
    }
    scene.atoms().forEach(node => append(node, output))
    return output
  }

  serialize(scene: SceneSurface): string { return this.clone(scene).innerHTML }

  dispose(): void {
    this.fragmentOwners = new WeakMap()
    this.atomOwners = new WeakMap()
    this.pages.clear()
    for (const scene of this.scenes) if (scene instanceof LiveSceneSurface) scene.fragments.length = 0
    this.scenes.length = 0
  }
}
