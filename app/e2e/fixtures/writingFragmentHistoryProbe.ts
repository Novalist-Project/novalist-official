import * as Y from 'yjs'
import { SceneMarkup } from '../../src/renderer/src/collaboration/sceneMarkup'
import { updateRichText } from '../../src/renderer/src/collaboration/richText'
import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'

declare global {
  interface Window {
    writingFragmentHistory: { snapshot(): { html: string; text: string; undo: number; redo: number; publications: number; normalizedBeforeCapture: boolean } }
  }
}

const editor = window as unknown as EditorWindow
const root = document.querySelector<HTMLElement>('#editor > .nv-page > section')!
const markup = new SceneMarkup(editor, root)
const doc = new Y.Doc()
const text = doc.getText('scene')
updateRichText(text, markup.read())
const writer = {}
const history = new Y.UndoManager(text, { trackedOrigins: new Set([writer]), captureTimeout: 0 })
let publications = 0
let normalizedBeforeCapture = false
document.getElementById('editor')!.addEventListener('input', () => {
  normalizedBeforeCapture = window.writingFragmentEnter.applied === 1 && window.writingFragmentEnter.error === null
  doc.transact(() => updateRichText(text, markup.read()), writer)
  publications++
})
document.getElementById('editor')!.addEventListener('keydown', event => {
  if (!event.ctrlKey || !['z', 'y'].includes(event.key.toLowerCase())) return
  event.preventDefault()
  if (event.key.toLowerCase() === 'z') history.undo()
  else history.redo()
  markup.render(text.toDelta())
})
window.writingFragmentHistory = {
  snapshot: () => ({ html: root.innerHTML, text: text.toString(), undo: history.undoStack.length, redo: history.redoStack.length,
    publications, normalizedBeforeCapture })
}
