import { useEffect, useState } from 'react'
import type { ChapterDto } from '../../stores/projectTypes'
import type { EditorWindow } from './editorBridge'
import type { SceneRef, SceneSnapshot, WritingScope } from './writingTypes'
import canvasCss from './writing-canvas.css?inline'
import { followWritingSceneRails } from './writingSceneRails'

export function useWritingCanvasStyles(live: EditorWindow | null): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    if (!live) return
    const style = live.document.createElement('style')
    style.textContent = canvasCss
    live.document.head.appendChild(style)
    live.document.body.classList.add('unified-writing-canvas')
    const sync = (): void => {
      const tokens = getComputedStyle(document.documentElement)
      for (const property of tokens) {
        if (property.startsWith('--nl-') && property !== '--nl-focus-page' && property !== '--nl-focus-ink')
          live.document.documentElement.style.setProperty(property, tokens.getPropertyValue(property))
      }
      const minimum = Number.parseFloat(tokens.getPropertyValue('--nl-writing-min-prose'))
      const scale = Number(live.document.body.style.getPropertyValue('--writing-text-scale')) || 1
      const fontRatio = live.document.body.classList.contains('book-width')
        ? Math.min(1, parseFloat(live.document.documentElement.style.getPropertyValue('--font-size')) / parseFloat(tokens.getPropertyValue('--nl-font-body'))) : 1
      const margin = Number.parseFloat(tokens.getPropertyValue('--nl-writing-margin-expanded')) * scale * fontRatio
      const gap = Number.parseFloat(tokens.getPropertyValue('--nl-writing-gap'))
      const next = live.innerWidth - margin - 3 * gap < minimum
      live.document.body.classList.toggle('writing-narrow', next)
      setNarrow(next)
    }
    sync()
    live.addEventListener('resize', sync)
    live.addEventListener('writingzoomchange', sync)
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
    return () => { style.remove(); observer.disconnect(); live.removeEventListener('resize', sync); live.removeEventListener('writingzoomchange', sync) }
  }, [live])
  return narrow
}

function chrome(live: EditorWindow, className = ''): HTMLElement {
  const element = live.document.createElement('div')
  element.dataset.editorChrome = 'writing'
  element.lang = live.document.documentElement.lang
  element.contentEditable = 'false'
  element.className = `writing-scene-chrome ${className}`
  return element
}

export function useWritingChromeTargets(live: EditorWindow | null, snapshots: SceneSnapshot[], chapterOrder: ChapterDto[],
  scope: WritingScope, anchorChapter: string | undefined, revision: number, includeEmpty: boolean) {
  const [targets, setTargets] = useState<{ scene: SceneRef; element: HTMLElement }[]>([])
  const [emptyTargets, setEmptyTargets] = useState<{ chapter: ChapterDto; element: HTMLElement }[]>([])
  const [endTarget, setEndTarget] = useState<HTMLElement | null>(null)
  const [introTarget, setIntroTarget] = useState<HTMLElement | null>(null)
  const structureKey = JSON.stringify([snapshots.map(scene => [scene.bookId, scene.draftId, scene.chapterGuid, scene.sceneId]),
    chapterOrder.map(chapter => [chapter.guid, chapter.scenes.length === 0]), scope,
    scope === 'chapter' ? anchorChapter : null, includeEmpty])
  useEffect(() => {
    if (!live) return
    const next = snapshots.flatMap(scene => {
      const root = live.getWritingSceneRoot(scene.sceneId)
      if (!root?.isConnected) return []
      const element = chrome(live)
      root.before(element)
      return [{ scene, element }]
    })
    const empty = chapterOrder.filter(chapter => includeEmpty && chapter.scenes.length === 0 && (scope === 'manuscript' || scope === 'chapter' && anchorChapter === chapter.guid))
      .map(chapter => {
        const element = chrome(live, 'writing-empty-chapter')
        const following = next.find(target => chapterOrder.findIndex(value => value.guid === target.scene.chapterGuid) > chapterOrder.indexOf(chapter))
        if (following) following.element.before(element)
        else live.document.getElementById('editor')?.appendChild(element)
        return { chapter, element }
      })
    const end = chrome(live, 'writing-end')
    live.document.getElementById('editor')?.appendChild(end)
    const intro = scope === 'manuscript' ? chrome(live, 'writing-book-chrome') : null
    if (intro) live.document.getElementById('editor')?.prepend(intro)
    setIntroTarget(intro)
    setTargets(next)
    setEmptyTargets(empty)
    setEndTarget(end)
    return () => { [...next, ...empty].forEach(target => target.element.remove()); end.remove(); intro?.remove() }
  }, [live, structureKey, revision])
  useEffect(() => live ? followWritingSceneRails(live, targets) : undefined, [live, targets])
  const currentChapters = new Map(chapterOrder.map(chapter => [chapter.guid, chapter]))
  return { targets, introTarget, emptyTargets: emptyTargets.map(target => ({ ...target,
    chapter: currentChapters.get(target.chapter.guid) ?? target.chapter })), endTarget }
}
