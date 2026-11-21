import type { WritingAnnotations } from './writingTypes'

export function removeWritingAnnotation(html: string, annotations: WritingAnnotations | null,
  kind: 'footnote' | 'comment', id: string): { html: string; annotations: WritingAnnotations } {
  if (!annotations) throw new Error('writing.annotationsUnavailable')
  const after = structuredClone(annotations)
  const template = document.createElement('template')
  template.innerHTML = html
  if (kind === 'footnote') {
    for (const marker of template.content.querySelectorAll<HTMLElement>('sup.nv-fn[data-fn-id]')) {
      if (marker.dataset.fnId === id) marker.remove()
    }
    const order = [...template.content.querySelectorAll<HTMLElement>('sup.nv-fn[data-fn-id]')]
      .map((marker, index) => { marker.textContent = String(index + 1); return marker.dataset.fnId })
    after.footnotes = after.footnotes.filter(note => note.id !== id).map(note => {
      const index = order.indexOf(note.id)
      return index < 0 ? note : { ...note, number: index + 1 }
    })
  } else {
    for (const marker of template.content.querySelectorAll<HTMLElement>('.nv-comment[data-comment-id]')) {
      if (marker.dataset.commentId !== id) continue
      marker.classList.remove('nv-comment', 'nv-comment-active')
      if (!marker.className) marker.removeAttribute('class')
      marker.removeAttribute('data-comment-id')
    }
    after.comments = after.comments.filter(comment => comment.id !== id)
  }
  return { html: template.innerHTML, annotations: after }
}
