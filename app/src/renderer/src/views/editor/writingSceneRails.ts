import type { EditorWindow } from './editorBridge'
import type { SceneRef } from './writingTypes'

interface RailTarget { scene: SceneRef; element: HTMLElement }

export function followWritingSceneRails(live: EditorWindow, targets: RailTarget[]): (() => void) | undefined {
  const viewport = live.document.getElementById('editor-wrapper')
  if (!viewport) return
  const rails = new Map<HTMLElement, HTMLElement>()
  const roots = new Map<HTMLElement, HTMLElement>()
  const visible = new Set<HTMLElement>()
  let pending = 0
  const refresh = (): void => {
    pending = 0
    const narrow = live.document.body.classList.contains('writing-narrow')
    const gap = parseFloat(getComputedStyle(viewport).getPropertyValue('--nl-space-md'))
    const top = viewport.getBoundingClientRect().top + gap
    for (const root of visible) {
      const rail = rails.get(root)!
      const bounds = root.getBoundingClientRect()
      const offset = narrow ? 0 : Math.max(0, Math.min(top - bounds.top, bounds.height - rail.offsetHeight))
      rail.style.translate = `0 ${offset}px`
    }
  }
  const schedule = (): void => { if (!pending) pending = live.requestAnimationFrame(refresh) }
  const measure = (rail: HTMLElement, root: HTMLElement): void => {
    const height = live.document.body.classList.contains('writing-narrow') ? 0 : Math.ceil(rail.offsetHeight)
    root.style.setProperty('--writing-rail-height', `${height}px`)
  }
  const sizes = new ResizeObserver(entries => {
    for (const entry of entries) {
      const rail = entry.target as HTMLElement, root = roots.get(rail)
      if (root) measure(rail, root)
    }
    schedule()
  })
  const visibility = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const root = entry.target as HTMLElement
      if (entry.isIntersecting) visible.add(root)
      else visible.delete(root)
    }
    schedule()
  }, { root: viewport })
  for (const target of targets) {
    const root = live.getWritingSceneRoot(target.scene.sceneId)
    const rail = target.element.querySelector<HTMLElement>('.writing-scene-margin')
    if (!root || !rail) continue
    rails.set(root, rail)
    roots.set(rail, root)
    sizes.observe(rail)
    visibility.observe(root)
    measure(rail, root)
  }
  viewport.addEventListener('scroll', schedule, { passive: true })
  live.addEventListener('resize', schedule)
  return () => {
    live.cancelAnimationFrame(pending)
    sizes.disconnect()
    visibility.disconnect()
    viewport.removeEventListener('scroll', schedule)
    live.removeEventListener('resize', schedule)
    for (const [root, rail] of rails) {
      root.style.removeProperty('--writing-rail-height')
      rail.style.removeProperty('translate')
    }
  }
}
