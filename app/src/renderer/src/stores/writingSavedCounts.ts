import { computeStats } from '../shell/textStatistics'
import { writingCountText } from '../views/editor/writingPresentation'
import type { SceneSnapshot, WritingContext } from '../views/editor/writingTypes'
import type { ProjectState } from './projectTypes'

export function writingSavedCounts(state: ProjectState, context: WritingContext,
  snapshot: SceneSnapshot): Partial<ProjectState> {
  if (state.projectPath !== context.workspaceId || state.workspaceEpoch !== context.workspaceEpoch ||
      state.activeBookId !== context.bookId || state.activeDraftId !== context.draftId ||
      snapshot.bookId !== context.bookId || snapshot.draftId !== context.draftId || snapshot.shared) return {}
  const chapterIndex = state.chapters.findIndex(chapter => chapter.guid === snapshot.chapterGuid)
  const chapter = state.chapters[chapterIndex]
  const sceneIndex = chapter?.scenes.findIndex(scene => scene.id === snapshot.sceneId) ?? -1
  if (!chapter || sceneIndex < 0 || chapter.scenes[sceneIndex].sharedProse) return {}
  const template = document.createElement('template')
  template.innerHTML = snapshot.html
  const wordCount = computeStats(writingCountText(template.content), '').wordCount
  if (chapter.scenes[sceneIndex].wordCount === wordCount) return {}
  const scenes = chapter.scenes.slice()
  scenes[sceneIndex] = { ...scenes[sceneIndex], wordCount }
  const chapters = state.chapters.slice()
  chapters[chapterIndex] = { ...chapter, scenes }
  return { chapters }
}
