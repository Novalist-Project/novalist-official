import * as Y from 'yjs'

export function encodeWritingUpdate(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192))
  return btoa(binary)
}

export function decodeWritingUpdate(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0))
}

export function previewWritingInverse(source: Uint8Array, update: Uint8Array): Uint8Array {
  const doc = new Y.Doc()
  const origin = {}
  Y.applyUpdate(doc, source)
  const history = new Y.UndoManager(doc.getText('prose'), { trackedOrigins: new Set([origin]) })
  try {
    Y.applyUpdate(doc, update, origin)
    const vector = Y.encodeStateVector(doc)
    history.undo()
    return Y.encodeStateAsUpdate(doc, vector)
  } finally { history.destroy(); doc.destroy() }
}
