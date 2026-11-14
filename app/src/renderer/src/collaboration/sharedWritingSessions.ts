import createDOMPurify from 'dompurify'
import { createSceneSanitizer } from '../../../shared/sceneSanitizer'
import type { SharedSceneIdentity } from '../../../shared/sharedScene'
import { SharedSceneSession } from './SharedSceneSession'
import { SharedEditorSession, type SharedEditorStatus } from './SharedEditorSession'
import { sharedWritingSceneSurface } from './richEditingSurface'
import { decodeState, sharedDocumentConnection } from './sharedDocuments'
import type { SceneRef, WritingContext } from '../views/editor/writingTypes'
import type { MarkupEnvironment } from './sceneMarkup'

const sessions = new Map<string, SharedSceneSession>()
const recovering = new Set<string>()
let markupEnvironment: MarkupEnvironment | undefined

function sharedMarkupEnvironment(): MarkupEnvironment {
  if (markupEnvironment?.document === window.document) return markupEnvironment
  const sanitizer = createSceneSanitizer(window, createDOMPurify(window))
  return markupEnvironment = { document: window.document,
    sanitizeSceneFragment: sanitizer.sanitizeSceneFragment, toDisplayImages: () => {} }
}

interface SharedWritingRecoveryIdentity { context: WritingContext; ref: SceneRef; shared: SharedSceneIdentity }

export async function transferRecoveredSharedWritingSession(previous: SharedWritingRecoveryIdentity, next: SharedWritingRecoveryIdentity): Promise<void> {
  if (!previous.context.workspaceId || previous.context.workspaceId !== next.context.workspaceId ||
      previous.context.bookId !== next.context.bookId || previous.context.draftId !== next.context.draftId ||
      previous.ref.bookId !== previous.context.bookId || previous.ref.draftId !== previous.context.draftId ||
      previous.ref.bookId !== next.ref.bookId || previous.ref.draftId !== next.ref.draftId ||
      previous.ref.chapterGuid !== next.ref.chapterGuid || previous.ref.sceneId !== next.ref.sceneId ||
      !Number.isSafeInteger(next.context.workspaceEpoch) || next.context.workspaceEpoch < 0 ||
      previous.shared.itemId !== next.shared.itemId) throw new Error('The recovered shared writing context or document identity changed.')
  const beforeKey = JSON.stringify([previous.shared.sessionId, previous.shared.itemId])
  const nextKey = JSON.stringify([next.shared.sessionId, next.shared.itemId])
  const owner = sessions.get(beforeKey)
  if (!owner) throw new Error('The recovering shared writing owner is no longer available.')
  if (recovering.has(beforeKey) || recovering.has(nextKey) || (sessions.has(nextKey) && sessions.get(nextKey) !== owner))
    throw new Error('The recovered shared identity already has a writing owner.')
  recovering.add(beforeKey); recovering.add(nextKey)
  try {
    await owner.rebindRecoveredConnection(sharedDocumentConnection(next.shared), decodeState(next.shared.state))
    sessions.delete(beforeKey)
    sessions.set(nextKey, owner)
  } finally { recovering.delete(beforeKey); recovering.delete(nextKey) }
}

export function findSharedWritingSession(identity: Pick<SharedSceneIdentity, 'sessionId' | 'itemId'>): SharedSceneSession | undefined {
  return sessions.get(JSON.stringify([identity.sessionId, identity.itemId]))
}

export function transferSharedWritingSession(previous: SharedSceneIdentity, next: SharedSceneIdentity): void {
  const beforeKey = JSON.stringify([previous.sessionId, previous.itemId])
  const nextKey = JSON.stringify([next.sessionId, next.itemId])
  const owner = sessions.get(beforeKey)
  if (!owner || beforeKey === nextKey) return
  if (recovering.has(nextKey) || sessions.has(nextKey)) throw new Error('The new shared identity already has a writing owner.')
  owner.rebindConnection(sharedDocumentConnection(next), decodeState(next.state))
  sessions.delete(beforeKey)
  sessions.set(nextKey, owner)
}

export function transferExternalSharedWritingSession(token: string, previous: SharedSceneIdentity, next: SharedSceneIdentity): void {
  if (previous.itemId !== next.itemId) throw new Error('A recovered shared owner must retain its document identity.')
  const beforeKey = JSON.stringify([previous.sessionId, previous.itemId])
  const nextKey = JSON.stringify([next.sessionId, next.itemId])
  const owner = sessions.get(beforeKey)
  if (!owner) throw new Error('The reserved shared writing owner is no longer available.')
  const existing = sessions.get(nextKey)
  if (recovering.has(nextKey) || (existing && existing !== owner)) throw new Error('The recovered shared identity already has a writing owner.')
  owner.rebindExternalConnection(token, sharedDocumentConnection(next), decodeState(next.state))
  sessions.delete(beforeKey)
  sessions.set(nextKey, owner)
}

export function getSharedWritingSession(identity: SharedSceneIdentity): SharedSceneSession {
  const key = JSON.stringify([identity.sessionId, identity.itemId])
  if (recovering.has(key)) throw new Error('The shared writing session is recovering its connection.')
  let session = sessions.get(key)
  if (!session || session.isClosed) {
    session = new SharedSceneSession(sharedMarkupEnvironment(),
    decodeState(identity.state), sharedDocumentConnection(identity))
    sessions.set(key, session)
  }
  return session
}

function releaseUnusedSession(owner: SharedSceneSession): void {
  if (!owner.releaseUnused()) return
  for (const [key, session] of sessions) if (session === owner) sessions.delete(key)
}

export function observeSharedWritingSession(identity: SharedSceneIdentity, changed: () => void): () => void {
  const owner = getSharedWritingSession(identity)
  const unsubscribe = owner.observe(changed)
  return () => { unsubscribe(); releaseUnusedSession(owner) }
}

export function createSharedWritingBinding(editor: Parameters<typeof sharedWritingSceneSurface>[0], sceneId: string,
  identity: SharedSceneIdentity, changed: (status: SharedEditorStatus) => void, captureWritingTransaction?: () => void): SharedEditorSession {
  const owner = getSharedWritingSession(identity)
  return new SharedEditorSession(sharedWritingSceneSurface(editor, sceneId, captureWritingTransaction), decodeState(identity.state),
    sharedDocumentConnection(identity), changed, owner, () => releaseUnusedSession(owner))
}

export async function closeSharedWritingSessions(): Promise<void> {
  (await prepareSharedWritingSessionsClose())()
}

export async function prepareSharedWritingSessionsClose(): Promise<() => void> {
  const disposals: (() => void)[] = []
  for (const [key, session] of sessions) {
    const dispose = await session.prepareClose()
    disposals.push(() => {
      dispose()
      if (sessions.get(key) === session) sessions.delete(key)
    })
  }
  return () => { for (const dispose of disposals) dispose() }
}
