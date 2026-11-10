import type { EditorMessage, EditorWindow } from './editorBridge'
import type { WritingAnnotations } from './writingTypes'

export interface WritingFrameAdapter {
  pageViewEnabled?: boolean
  changePageView?(enabled: boolean): void
  requestStructure?(command: 'sceneBreak' | 'chapterHeading' | 'insertChapter'): void
  ready(editor: EditorWindow): void
  message(message: EditorMessage): boolean
  capture(): void
  dispose(): void
  readAnnotations(): WritingAnnotations | null
  writeAnnotations(annotations: WritingAnnotations): void
}
