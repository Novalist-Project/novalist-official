import { create } from 'zustand'
import { rpc } from '../rpc/client'
import i18n from '../i18n'
import { hasWorkspaceDialogDraft, revealWorkspaceDialogDraft } from '../shell/useWorkspaceDialogGuard'
import { useProjectStore } from './projectStore'
import { flushPendingWrites } from './pendingWrites'
import { recordExternalWritingTransaction } from './writingHistory'
import { prepareSharedWritingStructure, type PreparedSharedWritingStructure } from '../collaboration/sharedWritingStructure'
import type { StructureCommand, StructureRequest, StructureResult } from '../views/editor/writingStructureTypes'
import type { HistoryResult, SceneRef, WritingContext, WritingSelection } from '../views/editor/writingTypes'

interface PendingStructure {
  request: StructureRequest
  context: WritingContext
  shared: PreparedSharedWritingStructure | null
  beforeSelection: WritingSelection | null
}
interface StructureStatus {
  pending: PendingStructure | null
  busy: boolean
  error: string | null
}
export const useWritingStructureStatus = create<StructureStatus>(() => ({ pending: null, busy: false, error: null }))

function currentRegistry(context?: WritingContext) {
  const state = useProjectStore.getState()
  if (context && (state.projectPath !== context.workspaceId || state.activeBookId !== context.bookId || state.activeDraftId !== context.draftId)) {
    throw new Error('writing.structureWorkspaceChanged')
  }
  const registry = state.getWritingRegistry()
  if (!registry) throw new Error('writing.workspaceUnavailable')
  return registry
}

async function requestStructure(method: string, args: unknown[]): Promise<StructureResult> {
  return rpc.request<StructureResult>(method, args)
}

function sceneSelection(ref: SceneRef | null): WritingSelection | null {
  if (!ref) return null
  const point = { sceneId: ref.sceneId, offset: 0, affinity: 'after' as const }
  return { anchor: point, focus: point }
}

function recordStructure(pending: PendingStructure, result: Extract<StructureResult, { status: 'committed' }>): void {
  const owner = currentRegistry(pending.context)
  const afterSelection = sceneSelection(result.focusScene)
  const refs = owner.capture().map(({ bookId, draftId, chapterGuid, sceneId }) => ({ bookId, draftId, chapterGuid, sceneId }))
  if (result.focusScene) refs.push(result.focusScene)
  const inverse = async (direction: 'undo' | 'redo'): Promise<HistoryResult> => {
    const registry = currentRegistry(pending.context)
    await flushPendingWrites()
    const sharedInverse = pending.shared && await (direction === 'undo' ? pending.shared.prepareUndo() : pending.shared.prepareRedo())
    try {
      const response = await requestStructure(direction === 'undo' ? 'writing/undoStructure' : 'writing/redoStructure', [result.operationId, registry.context.workspaceEpoch, sharedInverse ?? null])
      if (response.status !== 'committed') {
        pending.shared?.rejected()
        return { status: 'blocked', reason: response.errorCode ?? 'writing.structureConflict' }
      }
      pending.shared?.appliedInverse(direction)
      return { status: 'applied', selection: direction === 'undo' ? pending.beforeSelection : afterSelection }
    } catch (error) {
      pending.shared?.rejected()
      throw error
    }
  }
  recordExternalWritingTransaction(owner, { id: result.operationId, context: owner.context, origin: 'writing-structure', kind: 'structure',
    changes: [], annotationChanges: [], beforeSelection: pending.beforeSelection, afterSelection }, {
    refs, undo: () => inverse('undo'), redo: () => inverse('redo'), dispose: () => pending.shared?.dispose()
  })
}

async function publishStructure(pending: PendingStructure): Promise<void> {
  const registry = currentRegistry(pending.context)
  useWritingStructureStatus.setState({ busy: true, error: null })
  useProjectStore.setState({ changingSceneStructure: true })
  try {
    await pending.shared?.prepareRetry()
    const result = await requestStructure('writing/structure', [{ ...pending.request, expectedEpoch: registry.context.workspaceEpoch }])
    if (result.status !== 'committed') {
      if (result.status === 'conflict') {
        pending.shared?.dispose()
        useWritingStructureStatus.setState({ pending: null })
      }
      throw new Error(result.errorCode)
    }
    pending.shared?.applied()
    recordStructure(pending, result)
    useWritingStructureStatus.setState({ pending: null })
    if (result.focusScene) useProjectStore.getState().setContextScene(result.focusScene.chapterGuid, result.focusScene.sceneId)
  } catch (error) {
    pending.shared?.rejected()
    useWritingStructureStatus.setState({ error: String(error) })
    throw error
  } finally {
    useWritingStructureStatus.setState({ busy: false })
    useProjectStore.setState({ changingSceneStructure: false })
    if (!useProjectStore.getState().workspaceBusy) document.querySelector('.shell, .app-shell')?.removeAttribute('inert')
  }
}

export async function executeWritingStructure(command: StructureCommand, beforeSelection: WritingSelection | null = null): Promise<void> {
  if (hasWorkspaceDialogDraft()) throw new Error(revealWorkspaceDialogDraft() ?? i18n.t('update.workspaceBusy'))
  if (useWritingStructureStatus.getState().busy || useWritingStructureStatus.getState().pending) throw new Error('writing.structureRetry')
  useWritingStructureStatus.setState({ busy: true, error: null })
  try {
    const pending = await prepareStructure(command, beforeSelection)
    useWritingStructureStatus.setState({ pending })
    await publishStructure(pending)
  } catch (error) {
    useWritingStructureStatus.setState({ busy: false, error: String(error) })
    throw error
  }
}

async function prepareStructure(command: StructureCommand, beforeSelection: WritingSelection | null): Promise<PendingStructure> {
  const registry = currentRegistry()
  await flushPendingWrites()
  let preparedCommand = command
  if (command.kind === 'splitScene' || command.kind === 'splitChapter') {
    const snapshot = registry.getSnapshot(command.ref)
    if (!snapshot) throw new Error('writing.sceneUnavailable')
    if (!snapshot.shared && snapshot.html !== command.sourceHtml) throw new Error('writing.structureConflict')
    preparedCommand = { ...command, expectedHash: snapshot.hash }
  }
  const shared = await prepareSharedWritingStructure(preparedCommand, registry)
  if (shared && (preparedCommand.kind === 'splitScene' || preparedCommand.kind === 'splitChapter')) preparedCommand = { ...preparedCommand, expectedHash: shared.expectedHash, sharedSplit: shared.sharedSplit }
  return { context: registry.context, shared, beforeSelection,
    request: { transactionId: crypto.randomUUID(), expectedEpoch: registry.context.workspaceEpoch, bookId: registry.context.bookId,
      draftId: registry.context.draftId, command: preparedCommand } }
}

export async function retryWritingStructure(): Promise<void> {
  const { pending, busy } = useWritingStructureStatus.getState()
  if (pending && !busy) await publishStructure(pending)
}
