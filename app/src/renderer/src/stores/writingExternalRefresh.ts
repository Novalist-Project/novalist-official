import { getWritingRegistries, WritingContextError } from './writingDocuments'
import type { WritingDiskConflict } from './writingDocuments'
import type { WritingContext } from '../views/editor/writingTypes'

export function getPendingWritingResolution(context: Pick<WritingContext, 'workspaceId' | 'workspaceEpoch'>): WritingDiskConflict | null {
  for (const owner of getWritingRegistries(context)) {
    const pending = owner.getPendingDiskConflict()
    if (pending) return pending
  }
  return null
}

export function getCurrentWritingConflict(conflict: WritingDiskConflict): WritingDiskConflict | null {
  const owner = getWritingRegistries(conflict.context).find(registry =>
    registry.context.bookId === conflict.context.bookId && registry.context.draftId === conflict.context.draftId)
  return owner?.getCurrentDiskConflict(conflict) ?? null
}

export async function refreshWritingOwners(context: Pick<WritingContext, 'workspaceId' | 'workspaceEpoch'>): Promise<WritingDiskConflict[]> {
  const conflicts: WritingDiskConflict[] = []
  for (const owner of getWritingRegistries(context)) {
    for (const snapshot of owner.capture()) {
      if (snapshot.shared) continue
      try {
        const result = await owner.refreshFromDisk(snapshot)
        if (result.status === 'conflict') conflicts.push(result.conflict)
      } catch (error) {
        if (error instanceof WritingContextError) break
        throw error
      }
    }
  }
  return conflicts
}

export function captureWritingSavedHashes(context: WritingContext): Map<string, string> {
  const owner = getWritingRegistries(context).find(registry => registry.context.bookId === context.bookId && registry.context.draftId === context.draftId)
  return new Map(owner?.captureExternal().map(({ saved }) => [saved.sceneId, saved.hash]) ?? [])
}
