import { capturePendingWrites } from '../../stores/pendingWrites'
import { getWritingRegistries } from '../../stores/writingDocuments'
import { useProjectStore } from '../../stores/projectStore'
import { getSharedWritingSession } from '../../collaboration/sharedWritingSessions'
import { encodeWritingUpdate } from '../../collaboration/sharedWritingUpdates'
import type { WritingSearchCapture, WritingSearchContext } from '../../../../shared/writingSearchProtocol'

export function captureLocalWritingSearch(context: WritingSearchContext): WritingSearchCapture {
  const state = useProjectStore.getState()
  if (state.projectPath !== context.workspaceId || state.workspaceEpoch !== context.workspaceEpoch) {
    throw new Error('The writing workspace changed during search capture.')
  }
  capturePendingWrites()
  return { owner: 0, snapshots: getWritingRegistries(context).flatMap(registry => registry.captureExternal().map(({ current: snapshot, saved }) => {
    if (!snapshot.shared) return { ...snapshot, dirty: snapshot.html !== saved.html }
    const session = getSharedWritingSession(snapshot.shared)
    session.assertReady()
    return { ...snapshot, html: session.html, revision: session.revision, dirty: true,
      shared: { ...snapshot.shared, state: encodeWritingUpdate(session.state()) } }
  })) }
}

export async function captureWritingSearch(context: WritingSearchContext): Promise<WritingSearchCapture[]> {
  return window.novalist.captureWritingSearch ? window.novalist.captureWritingSearch(context) : [captureLocalWritingSearch(context)]
}

export function installWritingSearchCapture(): void {
  window.novalist.onWritingSearchCapture?.(request => {
    try {
      const capture = captureLocalWritingSearch(request)
      window.novalist.writingSearchCaptured?.({ token: request.token, snapshots: capture.snapshots })
    } catch {
      window.novalist.writingSearchCaptured?.({ token: request.token, error: 'A writing window could not capture its current content.' })
    }
  })
}
