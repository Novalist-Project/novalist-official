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
}
declare global {
  interface Window {
    writingPanes: WritingPane[]
    installWriting(book: FixtureBook): void
  }
}
