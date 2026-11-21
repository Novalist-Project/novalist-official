import { createWritingRpcTransport, getWritingWorkspaceRegistries, transferRecoveredWritingRegistry,
  validateRecoveredWritingRegistry, type WritingRegistryRecovery } from './writingDocuments'
import { rebindWritingHistory } from './writingHistory'
import { findSharedWritingSession, transferRecoveredSharedWritingSession } from '../collaboration/sharedWritingSessions'
import { rebaseSharedWritingAnnotations } from '../collaboration/sharedWritingAnnotations'
import type { WritingContext } from '../views/editor/writingTypes'

export async function prepareWritingWorkspaceRecovery(workspaceId: string) {
  const registries = getWritingWorkspaceRegistries(workspaceId).filter(registry => !registry.isExternallyReserved)
  const owners: { registry: typeof registries[number]; recovery: WritingRegistryRecovery; source: WritingContext }[] = []
  try {
    for (const registry of registries) owners.push({ registry, source: registry.context, recovery: await registry.prepareRecovery() })
  } catch (error) { owners.forEach(owner => owner.recovery.release()); throw error }
  const release = (): void => { owners.forEach(owner => owner.recovery.release()) }
  return { release, async resume(context: Pick<WritingContext, 'workspaceId' | 'workspaceEpoch'>): Promise<void> {
    if (context.workspaceId !== workspaceId) throw new Error('Restore the previous writing workspace before recovering edits.')
    const targets = owners.map(owner => ({ ...owner, next: { ...owner.registry.context, workspaceEpoch: context.workspaceEpoch } }))
    for (const owner of targets) validateRecoveredWritingRegistry(owner.registry, owner.recovery, owner.next)
    for (const owner of targets) transferRecoveredWritingRegistry(owner.registry, owner.recovery, owner.next)
    await rebaseSharedWritingAnnotations(workspaceId, context.workspaceEpoch)
    const transport = createWritingRpcTransport()
    for (const { registry, recovery, source } of owners) {
      for (const snapshot of registry.capture()) {
        const content = await transport.read(snapshot)
        if (snapshot.shared) {
          if (!content.shared || content.shared.itemId !== snapshot.shared.itemId) throw new Error('Reconnect the shared writing scene before restoring its editor.')
          const session = findSharedWritingSession(snapshot.shared)
          if (session) {
            await transferRecoveredSharedWritingSession({ context: source, ref: snapshot, shared: snapshot.shared },
              { context: registry.context, ref: snapshot, shared: content.shared })
          }
        }
        recovery.refresh(snapshot, content)
      }
    }
    for (const { registry } of owners) rebindWritingHistory(registry, registry)
  } }
}
