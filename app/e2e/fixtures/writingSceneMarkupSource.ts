export function commentSceneMarkupSource(source: string): string {
  source = source.replaceAll('\r\n', '\n')
  const replace = (before: string, after: string): void => {
    if (source.split(before).length !== 2) throw new Error('The comment markup seam no longer matches its exact source.')
    source = source.replace(before, after)
  }
  replace('export class SceneMarkup {', `for (const tag of ['address', 'article', 'aside', 'dl', 'dt', 'dd', 'footer', 'header', 'main', 'nav', 'section']) blockTags.add(tag)
const wrapperTags = new Set(['a', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'font', 'code', 'mark', 'sup', 'sub'])
const blockSelector = [...blockTags].join(',')

export class SceneMarkup {`)
  replace('return blockTags.has(element.tagName.toLowerCase())', `return blockTags.has(element.localName) || (wrapperTags.has(element.localName) && element.querySelector(blockSelector) !== null)`)
  replace('!blockTags.has(block.tag)', '!(blockTags.has(block.tag) || wrapperTags.has(block.tag))')
  replace('domPosition(index: number)', "domPosition(index: number, affinity: 'forward' | 'backward' = 'backward')")
  replace('for (const entry of this.textNodes)', "for (const entry of affinity === 'forward' ? this.textNodes.toReversed() : this.textNodes)")
  replace('    this.identities.set(safe, block.id)', `    if (safe.localName !== block.tag || (wrapperTags.has(block.tag) &&
        (safe.attributes.length !== element.attributes.length || Array.from(element.attributes).some(attribute => safe.getAttribute(attribute.name) !== attribute.value))))
      throw new Error('Unsupported shared authored wrapper.')
    this.identities.set(safe, block.id)`)
  return source
}

export function fragmentSceneMarkupSource(source: string): string {
  source = source.replaceAll('\r\n', '\n')
  const replace = (before: string, after: string): void => {
    if (source.split(before).length !== 2) throw new Error('The live scene markup seam no longer matches its exact source.')
    source = source.replace(before, after)
  }
  replace("import { renderRichText, type TextRun } from './richText'", "import { renderRichText, type TextRun } from './richText'\nimport type { SceneSurface } from '../../../../e2e/fixtures/writingSceneSurface'")
  replace('  private identities = new WeakMap<Node, string>()', `  private surface?: SceneSurface
  attachSurface(surface: SceneSurface): void { this.surface = surface }
  private identities = new WeakMap<Node, string>()`)
  replace("child.classList.contains('nv-page') ? path", "!this.surface && child.classList.contains('nv-page') ? path")
  replace('    for (const node of element.childNodes) {\n      if (node.nodeType', '    for (const node of element === this.root && this.surface ? this.surface.atoms() : element.childNodes) {\n      if (node.nodeType')
  replace('    this.boundaries.push({ node: element, offsets: position.offsets })\n    if (inline ||', `    if (element === this.root && this.surface) {
      let first = 0
      for (const fragment of this.surface.fragments) {
        const offsets = position.offsets.slice(first, first + fragment.childNodes.length + 1)
        this.positions.set(fragment, { start: offsets[0], offsets })
        this.boundaries.push({ node: fragment, offsets })
        first += fragment.childNodes.length
      }
    } else this.boundaries.push({ node: element, offsets: position.offsets })
    if (inline ||`)
  replace('    this.editor.toDisplayImages(this.root)', '    for (const fragment of this.surface?.fragments ?? [this.root]) this.editor.toDisplayImages(fragment)')
  replace(`    const safe = this.editor.sanitizeSceneFragment(element.outerHTML).firstElementChild
    if (!safe) throw new Error('Unsupported shared paragraph.')`, `    const contexts: Record<string, string[]> = {
      thead: ['table'], tbody: ['table'], tfoot: ['table'],
      tr: ['table', 'tbody'], td: ['table', 'tbody', 'tr'], th: ['table', 'tbody', 'tr']
    }
    const ancestors = contexts[block.tag] ?? []
    const html = ancestors.reduceRight((content, tag) => '<' + tag + '>' + content + '</' + tag + '>', element.outerHTML)
    let container: Element | DocumentFragment = this.editor.sanitizeSceneFragment(html)
    for (const tag of [...ancestors, block.tag]) {
      const child = container.firstElementChild
      if (container.children.length !== 1 || !child || child.localName !== tag) throw new Error('Unsupported shared paragraph.')
      container = child
    }
    const safe = container as Element`)
  replace('    const previous = Array.from(parent.childNodes)\n    const used = new Set<Node>()\n    let index = 0\n    for (const target of Array.from(desired.childNodes)) {', `    const surface = parent === this.root ? this.surface : undefined
    const previous = Array.from(surface ? surface.atoms() : parent.childNodes)
    const targets = Array.from(desired.childNodes)
    const keyed = new Map(targets.flatMap(target => {
      const id = this.identities.get(target)
      const node = id ? previous.find(candidate => this.identities.get(candidate) === id && candidate.nodeName === target.nodeName) : undefined
      return node ? [[target, node] as const] : []
    }))
    const reserved = new Set(keyed.values())
    const used = new Set<Node>()
    const ordered: Node[] = []
    for (const target of targets) {`)
  replace('      const existing = id ? previous.find(node => !used.has(node) && this.identities.get(node) === id && node.nodeName === target.nodeName) : previous[index]', `      const existing = id ? keyed.get(target) : previous.find(node => !used.has(node) && !reserved.has(node) && node.nodeType === target.nodeType && node.nodeName === target.nodeName)`)
  replace('      if (parent.childNodes[index] !== node) parent.insertBefore(node, parent.childNodes[index] ?? null)\n      used.add(node)\n      index++\n    }\n    while (parent.childNodes.length > index) parent.lastChild?.remove()', `      used.add(node)
      ordered.push(node)
    }
    let next: Node | null = null
    for (const node of ordered.toReversed()) {
      const current = Array.from(surface ? surface.atoms() : parent.childNodes).filter(candidate => used.has(candidate))
      const index = current.indexOf(node)
      if (index < 0 || (current[index + 1] ?? null) !== next) {
        if (surface) surface.insertBefore(node, next)
        else parent.insertBefore(node, next)
      }
      next = node
    }
    for (const node of previous) if (!used.has(node)) {
      if (surface) surface.remove(node)
      else node.parentNode?.removeChild(node)
    }`)
  return source
}
