import type { Page } from '@playwright/test'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'
import './writingContract'

export interface WritingMetrics {
  editorRuntimeCount: number
  sceneRootCount: number
  domNodeCount: number
  documentCount: number
  eventListenerCount: number
  heapUsedBytes: number
  inputSamplesMs: number[]
  inputP95Ms: number | null
  serializationSamplesMs: number[]
}

export async function measureWriting(page: Page, samplesPerPaneStart = 0): Promise<WritingMetrics> {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Performance.enable')
    await session.send('HeapProfiler.collectGarbage')
    const memory = await session.send('Performance.getMetrics')
    const dom = await session.send('Memory.getDOMCounters')
    const result = await page.evaluate(samplesPerPaneStart => {
      const frames = Array.from(document.querySelectorAll('iframe'))
      return {
        editorRuntimeCount: frames.filter(frame => typeof (frame.contentWindow as EditorWindow).setContent === 'function').length,
        sceneRootCount: frames.reduce((sum, frame) => sum + frame.contentDocument!.querySelectorAll('[data-scene-id]').length, 0),
        inputSamplesMs: window.writingPanes?.flatMap(pane => pane.samples().slice(samplesPerPaneStart)) ?? [],
        serializationSamplesMs: frames.flatMap(frame => frame.contentWindow?.writingCaptureTelemetry?.samplesMs ?? [])
      }
    }, samplesPerPaneStart)
    const samples = result.inputSamplesMs
    const sorted = [...samples].sort((a, b) => a - b)
    return { ...result, inputSamplesMs: samples, inputP95Ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
      domNodeCount: dom.nodes, documentCount: dom.documents, eventListenerCount: dom.jsEventListeners,
      heapUsedBytes: memory.metrics.find(metric => metric.name === 'JSHeapUsedSize')!.value }
  } finally { await session.detach() }
}

export async function writingEnvironment(page: Page) {
  const session = await page.context().newCDPSession(page)
  try {
    const version = await session.send('Browser.getVersion')
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }))
    return { os: platform(), osRelease: release(), arch: arch(), cpuModel: cpus()[0]?.model,
      logicalCpus: cpus().length, totalMemoryBytes: totalmem(), node: process.version,
      browser: version.product, javascript: version.jsVersion, engine: process.env.NOVALIST_WRITING_ENGINE ?? 'chromium-headless', viewport }
  } finally { await session.detach() }
}
