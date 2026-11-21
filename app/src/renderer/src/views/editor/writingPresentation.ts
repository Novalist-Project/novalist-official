import type { SceneRef, WritingContext } from './writingTypes'

export function writingCountText(fragment: DocumentFragment): string {
  const copy = fragment.cloneNode(true) as DocumentFragment
  for (const deleted of copy.querySelectorAll('del[data-nl-change]')) deleted.remove()
  for (const block of copy.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,ul,ol,li,dl,dt,dd,blockquote,pre,table,thead,tbody,tfoot,tr,td,th,figure,figcaption,br,hr')) {
    block.before('\n')
    block.after('\n')
  }
  return copy.textContent ?? ''
}

export function writingPresentationKey(context: WritingContext, scene: SceneRef): string {
  return `nl.writing.synopsis.${JSON.stringify([context.workspaceId, scene.bookId, scene.draftId, scene.sceneId])}`
}

export function synopsisExpanded(context: WritingContext, scene: SceneRef): boolean {
  return localStorage.getItem(writingPresentationKey(context, scene)) === 'true'
}

export function setSynopsisExpanded(context: WritingContext, scene: SceneRef, expanded: boolean): void {
  localStorage.setItem(writingPresentationKey(context, scene), String(expanded))
}

export function synopsisVisibilityKey(context: WritingContext): string {
  return `nl.writing.synopsisVisible.${context.workspaceId}`
}
