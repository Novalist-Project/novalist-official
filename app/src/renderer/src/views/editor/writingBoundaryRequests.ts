import type { ChapterDto } from '../../stores/projectTypes'
import type { WritingBoundaryRequests } from './WritingBoundaryActions'
import type { SceneRef, WritingScope } from './writingTypes'

function afterScene(chapters: ChapterDto[], chapterIndex: number, sceneIndex: number): WritingBoundaryRequests {
  const chapter = chapters[chapterIndex]
  const following = chapter.scenes[sceneIndex + 1]
  return {
    scene: { command: 'insertScene', selection: null, anchor: null,
      sceneDestination: { chapterGuid: chapter.guid, beforeSceneId: following?.id ?? null } },
    chapter: following
      ? null
      : { command: 'insertChapter', selection: null, anchor: null,
        destination: { beforeChapterGuid: chapters[chapterIndex + 1]?.guid ?? null, actName: chapter.act || null } }
  }
}

export function writingBoundaryRequests(chapters: ChapterDto[], scenes: SceneRef[], scope: WritingScope,
  anchorChapter: string | undefined, limited: boolean): { before: Map<string, WritingBoundaryRequests>; end: WritingBoundaryRequests | null } {
  const positions = new Map<string, { chapter: number; scene: number }>()
  chapters.forEach((chapter, chapterIndex) => chapter.scenes.forEach((scene, sceneIndex) => {
    positions.set(`${chapter.guid}/${scene.id}`, { chapter: chapterIndex, scene: sceneIndex })
  }))
  const position = (ref: SceneRef) => positions.get(`${ref.chapterGuid}/${ref.sceneId}`)
  const before = new Map<string, WritingBoundaryRequests>()
  scenes.forEach((current, index) => {
    const previous = scenes[index - 1]
    if (!previous) return
    const left = position(previous), right = position(current)
    if (!left || !right) return
    const adjacent = left.chapter === right.chapter ? right.scene === left.scene + 1
      : right.chapter === left.chapter + 1 && right.scene === 0 && left.scene === chapters[left.chapter].scenes.length - 1
    if (adjacent) before.set(current.sceneId, afterScene(chapters, left.chapter, left.scene))
  })
  if (limited) return { before, end: null }
  if (scope === 'manuscript' && chapters.length === 0) return { before, end: {
    scene: null, chapter: { command: 'insertChapter', selection: null, anchor: null,
      destination: { beforeChapterGuid: null, actName: null } }
  } }
  const last = scenes.at(-1)
  const lastPosition = last && position(last)
  if (last && lastPosition && (scope !== 'manuscript' || lastPosition.chapter === chapters.length - 1)) {
    return { before, end: afterScene(chapters, lastPosition.chapter, lastPosition.scene) }
  }
  const chapter = scope === 'chapter' ? chapters.find(value => value.guid === anchorChapter) : chapters.at(-1)
  const end = chapter && chapter.scenes.length === 0 ? {
    scene: { command: 'insertScene' as const, selection: null, anchor: null,
      sceneDestination: { chapterGuid: chapter.guid, beforeSceneId: null } },
    chapter: { command: 'insertChapter' as const, selection: null, anchor: null,
      destination: { beforeChapterGuid: chapters[chapters.indexOf(chapter) + 1]?.guid ?? null, actName: chapter.act || null } }
  } : null
  return { before, end }
}
