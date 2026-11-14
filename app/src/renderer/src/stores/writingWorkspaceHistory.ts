import { closeWritingDocumentRegistry, getWritingRegistries, sceneRefKey, type WritingDocumentRegistry } from './writingDocuments'
import { getWritingHistoryReferences, rebindWritingHistory } from './writingHistory'
import type { WritingHistoryRebase } from './writingHistoryRebase'
import type { WritingContext, SceneRef } from '../views/editor/writingTypes'
import type { ChapterDto } from './projectTypes'

export function captureWritingWorkspaceHistory(context: WritingContext) {
  const owners = getWritingRegistries(context).map(registry => {
    const refs = [...registry.capture(), ...getWritingHistoryReferences(registry)]
      .map(({ bookId, draftId, chapterGuid, sceneId }) => ({ bookId, draftId, chapterGuid, sceneId }))
    return { registry, refs: [...new Map(refs.map(ref => [sceneRefKey(ref), ref])).values()] }
  })
  return {
    async resume(current: WritingContext, chapters: readonly Pick<ChapterDto, 'guid' | 'scenes'>[],
      getRegistry: (context: WritingContext) => WritingDocumentRegistry | null): Promise<void> {
      if (current.workspaceId !== context.workspaceId) throw new Error('The writing workspace changed before history could resume.')
      const locations = new Map(chapters.flatMap(chapter => chapter.scenes.map(scene => [scene.id, chapter.guid] as const)))
      const prepared = await Promise.all(owners.map(async ({ registry, refs }) => {
        const next = getRegistry({ ...registry.context, workspaceEpoch: current.workspaceEpoch })
        if (!next) throw new Error('The writing workspace is unavailable.')
        const changes = await Promise.all(refs.map(async (before): Promise<WritingHistoryRebase> => {
          let after: SceneRef | null = before
          if (before.bookId === current.bookId && before.draftId === current.draftId) {
            const chapterGuid = locations.get(before.sceneId)
            after = chapterGuid ? { ...before, chapterGuid } : null
          }
          if (!after) return { before, after: null }
          const snapshot = await next.read(after)
          return { before, after, expectedHtml: snapshot.html, expectedHash: snapshot.hash }
        }))
        return { previous: registry, next, changes }
      }))
      for (const { previous, next, changes } of prepared) rebindWritingHistory(previous, next, changes)
      for (const { previous, next } of prepared) if (previous !== next) await closeWritingDocumentRegistry(previous.context)
    }
  }
}
