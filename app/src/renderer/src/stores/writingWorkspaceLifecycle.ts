import { prepareWritingDocumentClose, getWritingRegistries } from './writingDocuments'
import { assertWritingHistoriesAvailable, prepareWritingHistoriesClose } from './writingHistory'
import { prepareSharedWritingAnnotationsClose } from '../collaboration/sharedWritingAnnotations'
import { prepareSharedWritingSessionsClose } from '../collaboration/sharedWritingSessions'
import type { WritingContext } from '../views/editor/writingTypes'

/** Preparation can be vetoed by another window; retain all owners until commit. */
export async function prepareWritingWorkspaceClose(context: Pick<WritingContext, 'workspaceId' | 'workspaceEpoch'>): Promise<() => void> {
  const registries = getWritingRegistries(context)
  assertWritingHistoriesAvailable(context.workspaceId)
  const disposals = [await prepareSharedWritingAnnotationsClose(context.workspaceId), await prepareSharedWritingSessionsClose()]
  for (const registry of registries) disposals.push(await prepareWritingDocumentClose(registry.context))
  disposals.push(prepareWritingHistoriesClose(context.workspaceId))
  return () => { for (const dispose of disposals) dispose() }
}
