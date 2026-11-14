export function cloneFragmentPaperWithoutEngine(): void {
  const frame = document.querySelector('iframe')!
  const source = frame.contentDocument!
  const clone = source.documentElement.cloneNode(true) as HTMLElement
  clone.querySelectorAll('script').forEach(script => script.remove())
  const base = source.createElement('base')
  base.href = source.URL
  clone.querySelector('head')!.prepend(base)
  frame.srcdoc = '<!doctype html>' + clone.outerHTML
}

export function measureFragmentPaperText() {
  const root = document.getElementById('editor')!
  const wrapper = document.getElementById('editor-wrapper')!
  const paragraphs = Array.from(root.querySelectorAll('p'))
  const range = document.createRange()
  const points = [2, 5].map(offset => {
    range.setStart(paragraphs[0].firstChild!, offset)
    range.collapse(true)
    const caret = range.getBoundingClientRect()
    return { x: caret.x, y: caret.y + caret.height / 2 }
  })
  const characters = paragraphs.map(paragraph => Array.from({ length: paragraph.firstChild!.textContent!.length }, (_, offset) => {
    range.setStart(paragraph.firstChild!, offset)
    range.setEnd(paragraph.firstChild!, offset + 1)
    return Array.from(range.getClientRects(), rect => rect.toJSON())
  }))
  return { points, characters, pages: Array.from(root.querySelectorAll('.nv-page'), page => page.getBoundingClientRect().toJSON()),
    transform: getComputedStyle(root).transform, width: root.offsetWidth,
    viewport: { width: wrapper.clientWidth, height: wrapper.clientHeight, scrollWidth: wrapper.scrollWidth, scrollHeight: wrapper.scrollHeight,
      left: wrapper.scrollLeft, top: wrapper.scrollTop } }
}

export function installFragmentTransformCarrier(owner: 'editor' | 'carrier') {
  const root = document.getElementById('editor')!
  const surface = root.parentElement!
  const wrapper = document.getElementById('editor-wrapper')!
  const previous = getComputedStyle(root)
  const transform = previous.transform
  const width = previous.width
  const carrier = document.createElement('div')
  carrier.style.cssText = `width:${width};margin:0;padding:0;border:0;transform-origin:0 0;`
  surface.insertBefore(carrier, root)
  carrier.appendChild(root)
  if (owner === 'carrier') { carrier.style.transform = transform; root.style.transform = 'none' }
  const paragraphs = Array.from(root.querySelectorAll('p'))
  const range = document.createRange()
  const rects = paragraphs.map((paragraph, index) => {
    const node = paragraph.firstChild!
    range.setStart(node, index === 0 ? 2 : 3)
    range.collapse(true)
    const caret = range.getBoundingClientRect().toJSON()
    const characters = Array.from({ length: node.textContent!.length }, (_, offset) => {
      range.setStart(node, offset)
      range.setEnd(node, offset + 1)
      return Array.from(range.getClientRects(), rect => rect.toJSON())
    })
    return { paragraph: paragraph.getBoundingClientRect().toJSON(), caret, characters }
  })
  const ancestors = [root, carrier, surface, wrapper, document.body].map(element => {
    const style = getComputedStyle(element)
    return { transform: style.transform, origin: style.transformOrigin, overflowX: style.overflowX, overflowY: style.overflowY,
      whiteSpace: style.whiteSpace, userSelect: style.userSelect }
  })
  return { ancestors, geometry: { rects, editorLayoutWidth: root.offsetWidth,
    pages: Array.from(root.querySelectorAll('.nv-page'), page => {
      const style = getComputedStyle(page)
      return { rect: page.getBoundingClientRect().toJSON(), padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft], budget: 48 * parseFloat(style.fontSize) }
    }), viewport: { width: wrapper.clientWidth, height: wrapper.clientHeight, scrollWidth: wrapper.scrollWidth, scrollHeight: wrapper.scrollHeight,
      left: wrapper.scrollLeft, top: wrapper.scrollTop }, scripts: document.scripts.length, hasEngine: 'NovalistEditorState' in window } }
}
