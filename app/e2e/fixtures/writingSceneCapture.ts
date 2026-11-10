import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'
import { contentRecords, scenePoint, type WritingPresentation } from './writingPresentation'
import type { SceneProjection, SceneSurface } from './writingSceneSurface'
import { logicalSceneText } from './writingSceneText'

export interface CaptureTelemetry { samplesMs: number[]; sceneIds: string[] }
declare global { interface Window { writingCaptureTelemetry?: CaptureTelemetry } }
interface CaptureEditor extends EditorWindow {
  NovalistEditorState: { isComposing: boolean; isSettingContent: boolean }
  getCleanContentHtml(root?: HTMLElement, unwrapPresentation?: boolean): string
  buildGrammarPlainTextMap(root?: HTMLElement, nodes?: readonly Node[]): { plainText: string; textNodes: unknown[] }
  reportContentChanged(): void
  sendMessage(message: object): void
  writingCaptureTelemetry: CaptureTelemetry
}

type CaptureOwner = HTMLElement | SceneSurface
const isSurface = (scene: CaptureOwner): scene is SceneSurface => 'fragments' in scene

export function installSceneCapture(editor: CaptureEditor, presentation: WritingPresentation, projection?: SceneProjection): (scene: HTMLElement) => () => void {
  const root = editor.document.getElementById('editor')!
  const scenes: CaptureOwner[] = projection?.scenes ?? Array.from(root.querySelectorAll<HTMLElement>('[data-scene-id]'))
  const clean = editor.getCleanContentHtml.bind(editor)
  const map = editor.buildGrammarPlainTextMap.bind(editor)
  const cleanScene = (scene: CaptureOwner): string => isSurface(scene) ? clean(projection!.clone(scene), false) : clean(scene)
  const text = (scene: CaptureOwner): string => isSurface(scene) ? logicalSceneText(scene.atoms()) : scene.innerText
  const identity = (scene: CaptureOwner): string => isSurface(scene) ? scene.sceneId : scene.dataset.sceneId!
  const owner = (node: Node): CaptureOwner | null => {
    if (projection) return projection.owner(node)
    const element = node.nodeType === 1 ? node as Element : node.parentElement
    return element?.closest<HTMLElement>('[data-scene-id]') ?? null
  }
  const baseline = new Map(scenes.map(scene => [scene, cleanScene(scene)]))
  const dirty = new Set<CaptureOwner>()
  const telemetry: CaptureTelemetry = { samplesMs: [], sceneIds: [] }
  editor.writingCaptureTelemetry = telemetry
  const active = (): CaptureOwner | null => {
    const selection = editor.getSelection()
    if (projection) return projection.locate(selection?.focusNode ?? null, selection?.focusOffset ?? 0)?.scene ?? null
    return scenePoint(root, selection?.focusNode ?? null, selection?.focusOffset ?? 0)?.scene ?? null
  }
  const serialize = (scene: CaptureOwner): string => {
    const start = editor.performance.now()
    const result = cleanScene(scene)
    telemetry.samplesMs.push(editor.performance.now() - start)
    telemetry.sceneIds.push(identity(scene))
    return result
  }
  const markDirty = (records: MutationRecord[]) => {
    for (const record of records) {
      for (const node of [record.target, ...record.removedNodes, ...record.addedNodes]) {
        const scene = owner(node)
        if (scene) dirty.add(scene)
      }
    }
  }
  const observer = presentation.observe(root, markDirty)
  const capture = (scene: CaptureOwner, previous = baseline.get(scene)) => {
    if (editor.NovalistEditorState.isComposing || editor.NovalistEditorState.isSettingContent) return null
    markDirty(contentRecords(observer.takeRecords()))
    const html = serialize(scene)
    dirty.delete(scene)
    if (html === previous) return null
    baseline.set(scene, html)
    return { sceneId: identity(scene), html, plainText: text(scene) }
  }
  editor.getCleanContentHtml = scene => {
    const target = scene ? owner(scene) : active()
    return target ? serialize(target) : ''
  }
  editor.getPlainText = () => { const scene = active(); return scene ? text(scene) : '' }
  editor.buildGrammarPlainTextMap = scene => {
    const target = scene ? owner(scene) : active()
    return target ? isSurface(target) ? map(undefined, target.atoms()) : map(target) : { plainText: '', textNodes: [] }
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
  return fragment => {
    const scene = owner(fragment)
    if (!scene) throw new Error('Acknowledgement outside logical scene ownership')
    markDirty(contentRecords(observer.takeRecords()))
    const pendingLocal = dirty.has(scene)
    return () => {
      markDirty(contentRecords(observer.takeRecords()))
      if (pendingLocal) return
      baseline.set(scene, cleanScene(scene))
      dirty.delete(scene)
    }
  }
}
