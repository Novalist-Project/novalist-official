import { rpc } from '../rpc/client'
import { useProjectStore } from '../stores/projectStore'
import { findWriting, replaceWriting, replaceWritingNotes, revealWritingMatch } from '../views/editor/writingSearchHost'
import { searchRefKey, type WritingFindOptions, type WritingMatch, type WritingReplacement } from '../views/editor/writingSearch'

export interface FindMatchDto {
  bookId: string | null
  bookTitle: string | null
  chapterGuid: string
  chapterTitle: string
  sceneId: string
  sceneTitle: string
  before: string
  matchedText: string
  after: string
  field: string
  writing?: WritingMatch
}

export type ReplaceAction = 'current' | 'all' | 'notes'
export type ReplacementResult = WritingReplacement & { snapshots?: boolean, refreshError?: string }
export interface FindResults {
  matches: FindMatchDto[]
  replace(selected: FindMatchDto[], replacement: string, action: ReplaceAction): Promise<ReplacementResult>
}

export function isNote(match: FindMatchDto): boolean {
  return match.field === 'notes' || match.field === 'synopsis'
}

export async function navigateToMatch(match: FindMatchDto): Promise<void> {
  if (match.writing && match.field === 'prose') return revealWritingMatch(match.writing)
  const state = useProjectStore.getState()
  if (match.bookId && match.bookId !== state.activeBookId) await state.switchBook(match.bookId)
  if (match.bookId && useProjectStore.getState().activeBookId !== match.bookId) return
  await useProjectStore.getState().openScene(match.chapterGuid, match.sceneId)
}

async function searchMobile(options: WritingFindOptions, scope: string): Promise<FindResults> {
  const state = useProjectStore.getState()
  const { pattern, matchCase, wholeWord, useRegex, includeSceneNotes, includeCodex } = options
  const args = [matchCase, wholeWord, useRegex, scope, state.openChapterGuid, state.openSceneId, includeSceneNotes]
  const matches = await rpc.request<FindMatchDto[]>('search/find', [pattern, ...args, includeCodex])
  return { matches, async replace(selected, replacement) {
    const count = await rpc.request<number>('search/replaceAll', [pattern, replacement, ...args, selected])
    const current = useProjectStore.getState()
    if (current.projectPath === state.projectPath && current.openChapterGuid && current.openSceneId) {
      try { await current.openScene(current.openChapterGuid, current.openSceneId) }
      catch (reason) { return { count, snapshots: true, refreshError: String(reason) } }
    }
    return { count, snapshots: true }
  } }
}

export async function searchManuscript(options: WritingFindOptions, scope: string): Promise<FindResults> {
  if (window.novalist.isMobile) return searchMobile(options, scope)
  const result = await findWriting(options, scope)
  const targets = new Map(result.targets.map(target => [searchRefKey(target.ref), target]))
  const matches = result.matches.map(writing => {
    const target = targets.get(searchRefKey(writing.ref))
    return { ...writing, writing, ...writing.ref, bookTitle: target?.bookTitle ?? '',
      chapterTitle: target?.chapterTitle ?? '', sceneTitle: target?.sceneTitle ?? '' }
  })
  return { matches, async replace(selected, replacement, action) {
    const approved = selected.flatMap(match => match.writing ?? [])
    if (action === 'notes') return { count: await replaceWritingNotes(result, approved, replacement), snapshots: true }
    return replaceWriting(result, approved, replacement)
  } }
}
