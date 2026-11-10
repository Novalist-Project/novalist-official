type TextItem = number | { text: string; collapse: boolean; lineBreak?: boolean; capitalize?: boolean }

function textLocale(element: HTMLElement): string | undefined {
  const language = element.closest('[lang]')?.getAttribute('lang')
  if (!language) return undefined
  try { return Intl.getCanonicalLocales(language)[0] }
  catch (error) {
    if (error instanceof RangeError) return undefined
    throw error
  }
}

function textItems(node: Node, items: TextItem[]): void {
  const element = node.nodeType === 1 ? node as HTMLElement : node.parentElement
  if (!element) return
  const style = element.ownerDocument.defaultView!.getComputedStyle(element)
  if (node.nodeType === 3) {
    if (style.visibility !== 'visible') return
    let text = node.textContent ?? ''
    const locale = ['uppercase', 'lowercase'].includes(style.textTransform) ? textLocale(element) : undefined
    if (style.textTransform === 'uppercase') text = locale ? text.toLocaleUpperCase(locale) : text.toUpperCase()
    else if (style.textTransform === 'lowercase') text = locale ? text.toLocaleLowerCase(locale) : text.toLowerCase()
    const transform = { capitalize: style.textTransform === 'capitalize' }
    const collapse = style.whiteSpace === 'normal' || style.whiteSpace === 'nowrap'
    if (collapse) text = text.replace(/[\t\n\r ]+/g, ' ')
    else if (style.whiteSpace === 'pre-line') {
      text.split(/\r\n|[\r\n]/).forEach((line, index) => {
        if (index) items.push({ text: '\n', collapse: false, lineBreak: true })
        items.push({ text: line.replace(/[\t ]+/g, ' '), collapse: true, ...transform })
      })
      return
    }
    items.push({ text, collapse, ...transform })
    return
  }
  if (node.nodeType !== 1 || style.display === 'none') return
  const tag = element.tagName.toLowerCase()
  if (tag === 'br') {
    if (style.visibility === 'visible') items.push({ text: '\n', collapse: false })
    return
  }
  const tablePart = ['table-row', 'table-cell', 'table-row-group', 'table-header-group', 'table-footer-group'].includes(style.display)
  const breaks = tablePart ? 0 : tag === 'p' ? 2 : ['block', 'flow-root', 'flex', 'grid', 'list-item', 'table', 'table-caption'].includes(style.display) ? 1 : 0
  if (breaks) items.push(breaks)
  element.childNodes.forEach(child => textItems(child, items))
  if (style.display === 'table-cell' && element.nextElementSibling && element.ownerDocument.defaultView!.getComputedStyle(element.nextElementSibling).display === 'table-cell') {
    items.push({ text: '\t', collapse: false })
  }
  if (style.display === 'table-row' && element.nextElementSibling && element.ownerDocument.defaultView!.getComputedStyle(element.nextElementSibling).display === 'table-row') items.push(1)
  if (breaks) items.push(breaks)
}

export function logicalSceneText(nodes: readonly Node[]): string {
  const items: TextItem[] = []
  nodes.forEach(node => textItems(node, items))
  capitalizeWords(items)
  let output = ''
  let breaks = 0
  let space = false
  for (const item of items) {
    if (typeof item === 'number') { breaks = Math.max(breaks, item); space = false; continue }
    if (!item.text) continue
    if (breaks && output) output += '\n'.repeat(breaks)
    breaks = 0
    let text = item.text
    if (item.collapse) {
      if (!output || output.endsWith('\n') || output.endsWith(' ') || space) text = text.replace(/^ /, '')
      const trailing = text.endsWith(' ')
      if (trailing) text = text.slice(0, -1)
      if (space && text) output += ' '
      output += text
      space = trailing
    } else {
      if (space && !item.lineBreak) output += ' '
      output += text
      space = false
    }
  }
  return output
}

function capitalizeWords(items: TextItem[]): void {
  if (!items.some(item => typeof item !== 'number' && item.capitalize)) return
  const text = items.map(item => typeof item === 'number' ? '\n' : item.text).join('')
  const starts = new Set(Array.from(new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text))
    .filter(segment => segment.isWordLike).map(segment => segment.index))
  let offset = 0
  for (const item of items) {
    if (typeof item === 'number') { offset++; continue }
    const start = offset
    offset += item.text.length
    if (item.capitalize) item.text = item.text.replace(/\p{L}/gu, (letter: string, index: number) =>
      starts.has(start + index) ? letter.toUpperCase() : letter)
  }
}

declare global { interface Window { writingLogicalSceneText(nodes: readonly Node[]): string } }
