import { SharedWritingHistory } from '../collaboration/SharedWritingHistory'
import type { WritingNavigationSurface } from '../views/editor/writingNavigation'
import type { SceneRef, WritingAnnotations, WritingTransaction } from '../views/editor/writingTypes'
import { capturePendingWrites } from './pendingWrites'
import { sceneRefKey, type WritingDocumentRegistry } from './writingDocuments'
import { acceptSharedWritingBatch, acceptWritingTransaction } from './writingHistory'

export function editWritingAnnotations(registry: WritingDocumentRegistry, ref: SceneRef,
  transform: (before: WritingAnnotations) => WritingAnnotations, surface: WritingNavigationSurface | null): void {
  capturePendingWrites()
  const before = registry.getAnnotations(ref)
  if (!before) throw new Error('writing.annotationsUnavailable')
  const after = transform(structuredClone(before))
  const displayed = surface?.references.get(ref.sceneId)
  if (surface?.context === registry.context && displayed && sceneRefKey(displayed) === sceneRefKey(ref)) {
    surface.writeSceneAnnotations(ref, after)
    return
  }
  const transaction: WritingTransaction = { id: crypto.randomUUID(), context: registry.context,
    origin: 'inbox', kind: 'input', changes: [], annotationChanges: [{ ref, before, after }],
    beforeSelection: null, afterSelection: null }
  if (registry.getSnapshot(ref)?.shared)
    acceptSharedWritingBatch(registry, [{ registry, transaction }], new SharedWritingHistory(), new Map())
  else acceptWritingTransaction(registry, transaction)
}
