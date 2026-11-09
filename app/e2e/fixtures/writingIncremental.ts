import type * as Y from 'yjs'
import type { SceneMarkup } from '../../src/renderer/src/collaboration/sceneMarkup'

export function applySimpleInsertion(markup: SceneMarkup, delta: Y.YTextEvent['delta']): boolean {
  const insertion = delta.at(-1)
  if (!insertion || typeof insertion.insert !== 'string' || /[\n\ufffc]/.test(insertion.insert)) return false
  if (delta.length > 2 || (delta.length === 2 && (delta[0].retain === undefined || delta[0].attributes))) return false
  const offset = delta.length === 2 ? delta[0].retain! : 0
  const runs = markup.read()
  let position = 0
  const run = runs.find(run => {
    position += run.insert.length
    return offset < position
  })
  if (!run) return false
  const equalMarks = (left: Record<string, unknown>, right: Record<string, unknown>) =>
    JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort())
  if (!equalMarks(run.attributes ?? {}, insertion.attributes ?? {})) return false
  const target = markup.domPosition(offset)
  if (!target || target.node.nodeType !== Node.TEXT_NODE) return false
  ;(target.node as Text).insertData(target.offset, insertion.insert)
  markup.read()
  return true
}
