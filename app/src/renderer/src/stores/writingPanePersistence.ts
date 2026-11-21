import { WritingCommitError, type WritingDiskConflict, type WritingDocumentRegistry } from './writingDocuments'
import { findSharedWritingSession } from '../collaboration/sharedWritingSessions'
import { getSharedWritingAnnotations } from '../collaboration/sharedWritingAnnotations'

export async function flushWritingPane(registry: WritingDocumentRegistry, conflict: (value: WritingDiskConflict) => void): Promise<void> {
  try {
    await registry.flush()
    const shared = registry.capture().flatMap(snapshot => snapshot.shared ? [snapshot.shared] : [])
    for (const identity of shared) await findSharedWritingSession(identity)?.flush()
    if (shared.length) await getSharedWritingAnnotations(registry).flush()
  } catch (error) {
    if (error instanceof WritingCommitError && error.result.status === 'conflict') {
      for (const { ref } of error.result.conflicts) {
        if (ref.bookId !== registry.context.bookId || ref.draftId !== registry.context.draftId) continue
        const refreshed = await registry.refreshFromDisk(ref)
        if (refreshed.status === 'conflict') { conflict(refreshed.conflict); break }
      }
    }
    throw error
  }
}
