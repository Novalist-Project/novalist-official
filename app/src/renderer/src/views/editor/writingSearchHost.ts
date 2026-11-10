import { rpc } from '../../rpc/client'
import { useProjectStore } from '../../stores/projectStore'
import { useShellStore } from '../../stores/shellStore'
import { getWritingNavigation, type WritingNavigationSurface } from './writingNavigation'
import { capturePendingWrites } from '../../stores/pendingWrites'
import { acceptWritingBatch, acceptSharedWritingBatch } from '../../stores/writingHistory'
import { SharedWritingHistory } from '../../collaboration/SharedWritingHistory'
import { getSharedWritingSession } from '../../collaboration/sharedWritingSessions'
import { captureWritingSearch } from './writingSearchCapture'
import { replaceWritingAcrossWindows } from './writingSearchExternal'
import { captureSearchOverrides, matchSelection, searchRefKey, validateSearchChanges } from './writingSearch'
import { writingTextMapping } from './writingTextMapping'
import type { WritingFindOptions, WritingMatch, WritingSearchResult, WritingSearchTarget } from './writingSearch'
import type { SceneChange, WritingContext, WritingTransaction } from './writingTypes'

export function currentSearchContext(): WritingContext {
  const state = useProjectStore.getState()
  if (!state.projectPath || !state.activeBookId || !state.activeDraftId) throw new Error('No writing workspace is open.')
  return { workspaceId: state.projectPath, workspaceEpoch: state.workspaceEpoch, bookId: state.activeBookId, draftId: state.activeDraftId }
}

export async function findWriting(options: WritingFindOptions, scope: string): Promise<WritingSearchResult> {
  const context = currentSearchContext()
  const state = useProjectStore.getState()
  const navigation = getWritingNavigation(useShellStore.getState().activePaneId)
  const visible = new Set(navigation ? [...navigation.references.values()].map(searchRefKey) : [])
  const all = await rpc.request<WritingSearchTarget[]>('writingSearch/targets', [context.bookId, context.draftId, scope === 'Project'])
  const targets = all.filter(target => {
    if (scope === 'Projection' && navigation) return visible.has(searchRefKey(target.ref))
    if (scope === 'Projection' || scope === 'CurrentScene') return target.ref.sceneId === state.openSceneId && target.ref.chapterGuid === state.openChapterGuid
    if (scope === 'CurrentChapter') return target.ref.chapterGuid === state.openChapterGuid
    return true
  })
  const refs = targets.map(target => target.ref)
  const captures = await captureWritingSearch(context)
  const request = { options, targets: refs, overrides: captureSearchOverrides(refs, captures), expectedEpoch: context.workspaceEpoch }
  const matches = await rpc.request<WritingMatch[]>('writingSearch/find', [request])
  return { request, targets, matches }
}

function transaction(context: WritingContext, changes: SceneChange[], id: string): WritingTransaction {
  return { id, context, origin: 'find-replace', kind: 'replace', changes, annotationChanges: [], beforeSelection: null, afterSelection: null }
}

export function replaceWritingNotes(result: WritingSearchResult, replacement: string): Promise<number> {
  return rpc.request('writingSearch/replaceNotes', [result.request, replacement])
}

export async function replaceWriting(result: WritingSearchResult, selected: WritingMatch[], replacement: string): Promise<number> {
  if (!selected.length) return 0
  const context = currentSearchContext()
  if (context.workspaceEpoch !== result.request.expectedEpoch) throw new Error('The writing workspace changed.')
  const captures = await captureWritingSearch(context)
  const request = { ...result.request, overrides: captureSearchOverrides(result.request.targets, captures) }
  if (captures.length > 1) {
    return replaceWritingAcrossWindows(context, { ...result, request }, selected, replacement)
  }
  const changes = await rpc.request<SceneChange[]>('writingSearch/prepareReplace', [request, selected, replacement])
  const owner = useProjectStore.getState().getWritingRegistry(context)
  if (!owner) throw new Error('The writing owner is unavailable.')
  const groups = new Map<string, { registry: typeof owner; changes: SceneChange[] }>()
  for (const change of changes) {
    const registry = useProjectStore.getState().getWritingRegistry({ ...context, bookId: change.ref.bookId, draftId: change.ref.draftId })
    if (!registry) throw new Error('The writing owner is unavailable.')
    const key = JSON.stringify(registry.context)
    const group = groups.get(key) ?? { registry, changes: [] }
    group.changes.push(change)
    await registry.read(change.ref)
    groups.set(key, group)
  }
  capturePendingWrites()
  const sessions = new Map<string, ReturnType<typeof getSharedWritingSession>>()
  for (const group of groups.values()) {
    const snapshots = group.changes.map(change => {
      const snapshot = group.registry.getSnapshot(change.ref)!
      if (!snapshot.shared) return snapshot
      const session = getSharedWritingSession(snapshot.shared)
      sessions.set(searchRefKey(snapshot), session)
      return { ...snapshot, html: session.html, revision: session.revision }
    })
    validateSearchChanges(group.changes, snapshots)
  }
  const id = crypto.randomUUID()
  const entries = [...groups.values()].map(group => ({ registry: group.registry, transaction: transaction(group.registry.context, group.changes, id) }))
  if (sessions.size && changes.some(change => !sessions.has(searchRefKey(change.ref)))) {
    return replaceWritingAcrossWindows(context, { ...result, request }, selected, replacement)
  }
  if (sessions.size) {
    acceptSharedWritingBatch(owner, entries, new SharedWritingHistory(), sessions)
  } else acceptWritingBatch(owner, entries)
  return selected.length
}

async function revealValidatedMatch(navigation: WritingNavigationSurface, match: WritingMatch): Promise<boolean> {
  navigation.capture()
  const registry = useProjectStore.getState().getWritingRegistry(currentSearchContext())
  if (!registry) throw new Error('The writing owner is unavailable.')
  await registry.read(match.ref)
  navigation.capture()
  const snapshot = registry.getSnapshot(match.ref)
  if (!snapshot) throw new Error('The matching scene is unavailable.')
  const html = snapshot.shared ? getSharedWritingSession(snapshot.shared).html : snapshot.html
  const root = new DOMParser().parseFromString(html, 'text/html').body
  const text = writingTextMapping.parts(root).map(part => part.text).join('')
  if (match.index < 0 || match.length < 0 || match.index + match.length > text.length
    || text.slice(match.index, match.index + match.length) !== match.matchedText) {
    throw new Error('The search result changed. Search again before navigating.')
  }
  return navigation.reveal(match.ref, matchSelection(match))
}

export async function revealWritingMatch(match: WritingMatch): Promise<void> {
  let state = useProjectStore.getState()
  if (state.activeBookId !== match.ref.bookId) await state.switchBook(match.ref.bookId)
  state = useProjectStore.getState()
  if (state.activeDraftId !== match.ref.draftId) await state.switchDraft(match.ref.draftId)
  state = useProjectStore.getState()
  const visible = getWritingNavigation(useShellStore.getState().activePaneId)
  if (visible && await revealValidatedMatch(visible, match)) return
  await state.openScene(match.ref.chapterGuid, match.ref.sceneId)
  for (let attempt = 0; attempt < 60; attempt++) {
    const pane = useShellStore.getState().activePaneId
    const navigation = pane ? getWritingNavigation(pane) : null
    if (navigation && await revealValidatedMatch(navigation, match)) return
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }
  throw new Error('The matching scene could not be displayed.')
}
