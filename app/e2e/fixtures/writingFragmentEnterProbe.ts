interface EnterIntent {
  node: Text
  offset: number
  value: string
  fragment: Element
  paper: Element
  siblings: Node[]
}

declare global {
  interface Window { writingFragmentEnter: { applied: number; error: string | null; inputType: string; mutationCount: number } }
}

export function installFragmentEnterProbe(): void {
  const root = document.getElementById('editor')!
  const state = { applied: 0, error: null as string | null, inputType: '', mutationCount: 0 }
  window.writingFragmentEnter = state
  let intent: EnterIntent | null = null
  const delivered: MutationRecord[] = []
  const observer = new MutationObserver(records => { if (intent) delivered.push(...records) })
  observer.observe(root, { childList: true, characterData: true, subtree: true })
  root.addEventListener('beforeinput', event => {
    intent = null
    delivered.length = 0
    observer.takeRecords()
    const selection = window.getSelection()!
    const node = selection.anchorNode
    if (event.inputType !== 'insertParagraph' || !selection.isCollapsed || node?.nodeType !== Node.TEXT_NODE) return
    const fragment = node.parentElement!
    if (!window.writingFragmentProbe.registeredFragment(fragment) || fragment.childNodes.length !== 1) return
    intent = { node: node as Text, offset: selection.anchorOffset, value: node.textContent!, fragment,
      paper: fragment.parentElement!, siblings: Array.from(fragment.parentElement!.childNodes) }
  }, true)
  root.addEventListener('input', event => {
    const captured = intent
    intent = null
    if (!captured) return
    const records = [...delivered, ...observer.takeRecords()]
    delivered.length = 0
    state.inputType = event.inputType
    state.mutationCount = records.length
    const { node, offset, value, fragment, paper, siblings } = captured
    const added = Array.from(paper.childNodes).filter(child => !siblings.includes(child))
    const candidate = added[0]
    const before = offset === 0
    const expectedSibling = before ? fragment.previousSibling : fragment.nextSibling
    const knownMutation = records.some(record => record.target === paper && Array.from(record.addedNodes).includes(candidate))
    const shape = candidate instanceof HTMLElement && candidate.tagName === 'SECTION' && candidate === expectedSibling
      && candidate.getAttributeNames().length === 1 && candidate.getAttribute('style') === fragment.getAttribute('style')
      && candidate.childNodes.length === 1
    const nativeSplit = shape && (before
      ? candidate.firstChild instanceof HTMLBRElement && fragment.firstChild === node && node.data === value
      : candidate.firstChild === node && node.data === value.slice(offset) && fragment.childNodes.length === 1
        && fragment.firstChild?.nodeType === Node.TEXT_NODE && fragment.textContent === value.slice(0, offset))
    if (event.inputType !== 'insertParagraph' || added.length !== 1 || !knownMutation || !nativeSplit
      || siblings.some(sibling => sibling.parentNode !== paper)) {
      state.error = 'Unsupported native fragment split topology'
      return
    }
    const selection = window.getSelection()!
    const anchor = selection.anchorNode!, focus = selection.focusNode!
    const anchorOffset = selection.anchorOffset, focusOffset = selection.focusOffset
    const paragraph = document.createElement('div')
    while (candidate.firstChild) paragraph.appendChild(candidate.firstChild)
    fragment.insertBefore(paragraph, before ? fragment.firstChild : null)
    candidate.remove()
    selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
    state.applied++
  }, true)
}
