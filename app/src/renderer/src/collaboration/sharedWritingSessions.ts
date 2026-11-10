import createDOMPurify from 'dompurify'
import { createSceneSanitizer } from '../../../shared/sceneSanitizer'
import type { SharedSceneIdentity } from '../../../shared/sharedScene'
import { SharedSceneSession } from './SharedSceneSession'
import { SharedEditorSession, type SharedEditorStatus } from './SharedEditorSession'
import { sharedWritingSceneSurface } from './richEditingSurface'
import { decodeState, sharedDocumentConnection } from './sharedDocuments'

const sessions = new Map<string, SharedSceneSession>()

export function getSharedWritingSession(identity: SharedSceneIdentity): SharedSceneSession {
  const key = JSON.stringify([identity.sessionId, identity.itemId])
  let session = sessions.get(key)
  if (!session || session.isClosed) {
    const sanitizer = createSceneSanitizer(window, createDOMPurify(window))
    session = new SharedSceneSession({ document: window.document,
      sanitizeSceneFragment: sanitizer.sanitizeSceneFragment, toDisplayImages: () => {} },
    decodeState(identity.state), sharedDocumentConnection(identity))
    sessions.set(key, session)
  }
  return session
}

export function createSharedWritingBinding(editor: Parameters<typeof sharedWritingSceneSurface>[0], sceneId: string,
  identity: SharedSceneIdentity, changed: (status: SharedEditorStatus) => void, captureWritingTransaction?: () => void): SharedEditorSession {
  const owner = getSharedWritingSession(identity)
  return new SharedEditorSession(sharedWritingSceneSurface(editor, sceneId, captureWritingTransaction), decodeState(identity.state),
    sharedDocumentConnection(identity), changed, owner, () => {
      if (owner.releaseUnused()) sessions.delete(JSON.stringify([identity.sessionId, identity.itemId]))
    })
}

export async function closeSharedWritingSessions(): Promise<void> {
  const results = await Promise.allSettled([...sessions].map(async ([key, session]) => {
    await session.close()
    if (sessions.get(key) === session) sessions.delete(key)
  }))
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Shared writing sessions are still pending.')
}
