import { useProjectStore } from './projectStore'
import { getWritingRegistries } from './writingDocuments'
import { useEditorBridge } from './editorBridgeStore'
import { refreshSharedWritingAnnotations } from '../collaboration/sharedWritingAnnotations'
import type { RpcClient } from '../rpc/client'
import type { SceneRef } from '../views/editor/writingTypes'

interface AnnotationChangeNotice {
  workspaceId: string
  workspaceEpoch: number
  reference: SceneRef
}

export function registerWritingAnnotationNotifications(client: Pick<RpcClient, 'onNotification'>,
  reportError: (reason: unknown) => void): void {
  client.onNotification('writing/annotationsChanged', params => {
    const change = (Array.isArray(params) ? params[0] : params) as AnnotationChangeNotice | null
    if (change) void refreshExternalAnnotations(change).catch(reportError)
  })
}

async function refreshExternalAnnotations(change: AnnotationChangeNotice): Promise<void> {
  const current = (): boolean => {
    const state = useProjectStore.getState()
    return !window.novalist.isMobile && state.isLoaded && !state.workspaceBusy && !state.closingProject &&
      state.projectPath === change.workspaceId && state.workspaceEpoch === change.workspaceEpoch
  }
  if (!current()) return
  const { reference } = change
  const registry = getWritingRegistries(change).find(owner => owner.context.bookId === reference.bookId && owner.context.draftId === reference.draftId)
  const snapshot = registry?.getSnapshot(reference)
  try {
    if (registry && snapshot?.shared) await refreshSharedWritingAnnotations(registry, [reference])
    else if (registry && snapshot) {
      const result = await registry.refreshFromDisk(reference)
      if (result.status === 'conflict') throw new Error('writing.conflict')
    }
  } catch (error) { if (current()) throw error }
  if (current()) useEditorBridge.getState().annotationsChanged()
}
