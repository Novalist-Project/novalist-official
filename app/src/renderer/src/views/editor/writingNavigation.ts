import type { SceneRef, WritingAnnotations, WritingContext, WritingSelection } from './writingTypes'

export type WritingSceneTransform = (html: string, annotations: WritingAnnotations | null) => {
  html: string
  annotations?: WritingAnnotations
}

export interface WritingNavigationSurface {
  pageViewEnabled?: boolean
  changePageView?(enabled: boolean): void
  readonly context: WritingContext | null
  readonly references: ReadonlyMap<string, SceneRef>
  capture(): void
  reveal(ref: SceneRef, selection: WritingSelection): boolean
  writeSceneAnnotations(ref: SceneRef, annotations: WritingAnnotations): void
  transformScene(ref: SceneRef, transform: WritingSceneTransform): void
}

const panes = new Map<string, WritingNavigationSurface>()

export function registerWritingNavigation(paneId: string, surface: WritingNavigationSurface): () => void {
  panes.set(paneId, surface)
  return () => { if (panes.get(paneId) === surface) panes.delete(paneId) }
}

export function getWritingNavigation(paneId: string): WritingNavigationSurface | null {
  return panes.get(paneId) ?? null
}
