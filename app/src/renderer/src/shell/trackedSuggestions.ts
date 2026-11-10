export interface TrackedSuggestion {
  id: string
  kind: 'insertion' | 'deletion'
  text: string
  author: string
  at: string
}

const selector = 'ins[data-nl-change],del[data-nl-change]'

export function listTrackedSuggestions(html: string): TrackedSuggestion[] {
  const root = new DOMParser().parseFromString(html, 'text/html').body
  return Array.from(root.querySelectorAll(selector), mark => ({
    id: mark.getAttribute('data-nl-change')!, kind: mark.tagName === 'INS' ? 'insertion' : 'deletion',
    text: (mark.textContent ?? '').trim(), author: mark.getAttribute('data-nl-author') ?? '',
    at: mark.getAttribute('data-nl-at') ?? ''
  }))
}

export function resolveTrackedSuggestions(html: string, accept: boolean, id?: string): string {
  const root = new DOMParser().parseFromString(html, 'text/html').body
  const marks = Array.from(root.querySelectorAll(selector)).filter(mark =>
    id === undefined || mark.getAttribute('data-nl-change') === id)
  if (!marks.length) return html
  for (const mark of marks.reverse()) {
    if (accept === (mark.tagName === 'INS')) mark.replaceWith(...mark.childNodes)
    else mark.remove()
  }
  return root.innerHTML
}
