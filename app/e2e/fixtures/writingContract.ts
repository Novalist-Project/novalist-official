import type { FixtureBook } from './writingBook'

export interface WritingPoint { scene: number; offset: number }
export type WritingCommand = 'toggleBold' | 'toggleItalic' | 'toggleHighlight' | 'wrapSelectionAsComment'
export interface SceneResult { id: string; html: string; text: string }
export interface WritingPane {
  select(anchor: WritingPoint, focus: WritingPoint): void
  command(command: WritingCommand): void
  serialize(): SceneResult[]
  scope(indices: number[]): void
  undo(): void
  redo(): void
  remoteInsert(scene: number, offset: number, text: string): void
  capture(): void
  sampleCount(): number
  samples(): number[]
  sceneCount(): number
  activeScene(): string | null
  inspect(): { deltas: { insert: string; attributes?: Record<string, string> }[][]; undoGroups: number[][]; redoGroups: number[][] }
}
declare global {
  interface Window {
    writingPanes: WritingPane[]
    writingPublications: { sceneId: string; html: string }[]
    installWriting(book: FixtureBook, optimized: boolean, scoped: boolean, fragments?: boolean): void
  }
}
