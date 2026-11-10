import type { EditorWindow } from '../views/editor/editorBridge'
import type { MarkupEnvironment } from './sceneMarkup'

export interface RichEditingSurface extends MarkupEnvironment {
  root: HTMLElement
  getContent(): string
  getPlainText(): string
  flushPendingContentChange(): void
  managedTransactions?: boolean
  captureWritingTransaction?(): void
}

export function sharedWritingSceneSurface(editor: EditorWindow & {
  getWritingSceneRoot(sceneId: string): HTMLElement | null
  serializeWritingScene(sceneId: string): string
}, sceneId: string, captureWritingTransaction?: () => void): RichEditingSurface {
  const root = editor.getWritingSceneRoot(sceneId)
  if (!root) throw new Error('The shared writing scene is not mounted.')
  return { root, document: root.ownerDocument, managedTransactions: true, captureWritingTransaction,
    sanitizeSceneFragment: html => editor.sanitizeSceneFragment(html),
    toDisplayImages: content => editor.toDisplayImages(content),
    refreshLayout: () => editor.repaginatePageView(),
    getContent: () => editor.serializeWritingScene(sceneId),
    getPlainText: () => root.textContent ?? '',
    flushPendingContentChange: () => editor.flushPendingContentChange() }
}

export function sceneEditorSurface(editor: EditorWindow): RichEditingSurface {
  const root = editor.document.getElementById('editor')
  if (!root) throw new Error('The prose editor is not ready.')
  return {
    root, document: root.ownerDocument,
    sanitizeSceneFragment: html => editor.sanitizeSceneFragment(html),
    toDisplayImages: content => editor.toDisplayImages(content),
    refreshLayout: () => editor.repaginatePageView(),
    getContent: () => editor.getContent(),
    getPlainText: () => editor.getPlainText(),
    flushPendingContentChange: () => editor.flushPendingContentChange()
  }
}
