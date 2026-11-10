import type * as Y from 'yjs'
import type { WritingPoint, WritingSelection } from '../views/editor/writingTypes'
import type { SharedSceneSession } from './SharedSceneSession'

type RetainedPoint = { point: WritingPoint; shared?: { session: SharedSceneSession; position: Y.RelativePosition } }
export interface SharedWritingSelection { anchor: RetainedPoint; focus: RetainedPoint }

export function retainSharedWritingSelection(selection: WritingSelection | null,
  sessions: ReadonlyMap<string, SharedSceneSession>): SharedWritingSelection | null {
  if (!selection) return null
  const retain = (point: WritingPoint): RetainedPoint => {
    const session = sessions.get(point.sceneId)
    return { point: { ...point }, shared: session ? { session, position: session.relativePoint(point) } : undefined }
  }
  return { anchor: retain(selection.anchor), focus: retain(selection.focus) }
}

export function resolveSharedWritingSelection(selection: SharedWritingSelection | null): WritingSelection | null {
  if (!selection) return null
  const resolve = ({ point, shared }: RetainedPoint): WritingPoint | null => {
    if (!shared) return { ...point }
    const offset = shared.session.resolvePoint(shared.position)
    return offset === null ? null : { ...point, offset }
  }
  const anchor = resolve(selection.anchor)
  const focus = resolve(selection.focus)
  return anchor && focus ? { anchor, focus } : null
}
