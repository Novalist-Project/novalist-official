import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'
import { contentRecords, scenePoint, type WritingPresentation } from './writingPresentation'

export interface CaptureTelemetry { samplesMs: number[]; sceneIds: string[] }
declare global { interface Window { writingCaptureTelemetry?: CaptureTelemetry } }
interface CaptureEditor extends EditorWindow {
  NovalistEditorState: { isComposing: boolean; isSettingContent: boolean }
  getCleanContentHtml(root?: HTMLElement): string
  buildGrammarPlainTextMap(root?: HTMLElement): { plainText: string; textNodes: unknown[] }
  reportContentChanged(): void
  sendMessage(message: object): void
  writingCaptureTelemetry: CaptureTelemetry
}

export function installSceneCapture(editor: CaptureEditor, presentation: WritingPresentation): (scene: HTMLElement) => () => void {
  const root = editor.document.getElementById('editor')!
  const scenes = Array.from(root.querySelectorAll<HTMLElement>('[data-scene-id]'))
  const clean = editor.getCleanContentHtml.bind(editor)
  const map = editor.buildGrammarPlainTextMap.bind(editor)
  const baseline = new Map(scenes.map(scene => [scene, clean(scene)]))
  const dirty = new Set<HTMLElement>()
  const telemetry: CaptureTelemetry = { samplesMs: [], sceneIds: [] }
  editor.writingCaptureTelemetry = telemetry
  const active = (): HTMLElement | null => {
    const selection = editor.getSelection()
    return scenePoint(root, selection?.focusNode ?? null, selection?.focusOffset ?? 0)?.scene ?? null
  }
  const serialize = (scene: HTMLElement): string => {
    const start = editor.performance.now()
    const result = clean(scene)
    telemetry.samplesMs.push(editor.performance.now() - start)
    telemetry.sceneIds.push(scene.dataset.sceneId!)
    return result
  }
  const markDirty = (records: MutationRecord[]) => {
    for (const record of records) {
      const element = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement
      const scene = element?.closest<HTMLElement>('[data-scene-id]')
      if (scene) dirty.add(scene)
    }
  }
  const observer = presentation.observe(root, markDirty)
  const capture = (scene: HTMLElement, previous = baseline.get(scene)) => {
    if (editor.NovalistEditorState.isComposing || editor.NovalistEditorState.isSettingContent) return null
    const html = serialize(scene)
    dirty.delete(scene)
    if (html === previous) return null
    baseline.set(scene, html)
    return { sceneId: scene.dataset.sceneId!, html, plainText: scene.innerText }
  }
  editor.getCleanContentHtml = scene => {
    const target = scene ?? active()
    return target ? serialize(target) : ''
  }
  editor.getPlainText = () => active()?.innerText ?? ''
  editor.buildGrammarPlainTextMap = scene => {
    const target = scene ?? active()
    return target ? map(target) : { plainText: '', textNodes: [] }
  }
  editor.capturePendingContentChange = previous => {
    const target = active()
    return target ? capture(target, previous) : null
  }
  editor.reportContentChanged = () => {
    markDirty(contentRecords(observer.takeRecords()))
    for (const scene of dirty) {
      const change = capture(scene)
      if (change) editor.sendMessage({ type: 'contentChanged', ...change })
    }
  }
  return scene => {
    markDirty(contentRecords(observer.takeRecords()))
    const pendingLocal = dirty.has(scene)
    return () => {
      markDirty(contentRecords(observer.takeRecords()))
      if (pendingLocal) return
      baseline.set(scene, clean(scene))
      dirty.delete(scene)
    }
  }
}
