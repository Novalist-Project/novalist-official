import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'

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

export function installSceneCapture(editor: CaptureEditor): void {
  const root = editor.document.getElementById('editor')!
  const scenes = Array.from(root.querySelectorAll<HTMLElement>('[data-scene-id]'))
  const clean = editor.getCleanContentHtml.bind(editor)
  const map = editor.buildGrammarPlainTextMap.bind(editor)
  const baseline = new Map(scenes.map(scene => [scene, clean(scene)]))
  const dirty = new Set<HTMLElement>()
  const telemetry: CaptureTelemetry = { samplesMs: [], sceneIds: [] }
  editor.writingCaptureTelemetry = telemetry
  const active = (): HTMLElement | null => {
    const node = editor.getSelection()?.focusNode
    const element = node?.nodeType === 1 ? node as Element : node?.parentElement
    return element?.closest<HTMLElement>('[data-scene-id]') ?? null
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
  const observer = new MutationObserver(markDirty)
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true })
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
    markDirty(observer.takeRecords())
    for (const scene of dirty) {
      const change = capture(scene)
      if (change) editor.sendMessage({ type: 'contentChanged', ...change })
    }
  }
}
