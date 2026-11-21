import type { Page } from '@playwright/test'
import { open, readFile } from 'node:fs/promises'

export interface LayoutTraceEvent { name: string; ph: string; pid: number; tid: number; ts: number; dur?: number; args?: { name?: string } }
export interface LayoutTraceWindow { startUs: number; endUs: number }

function validateWindow(window: LayoutTraceWindow): void {
  if (!Number.isFinite(window.startUs) || !Number.isFinite(window.endUs) || window.endUs <= window.startUs) throw new Error('Invalid layout trace interval.')
}

export function profileTraceWindow(events: LayoutTraceEvent[]): LayoutTraceWindow {
  const starts = events.filter(event => event.name === 'writing-profile-start')
  const ends = events.filter(event => event.name === 'writing-profile-end')
  if (starts.length !== 1 || ends.length !== 1) throw new Error('Layout trace requires exactly one start and end marker.')
  const [start] = starts; const [end] = ends
  if (start.pid !== end.pid || start.tid !== end.tid || !events.some(event => event.name === 'thread_name' && event.args?.name === 'CrRendererMain' && event.pid === start.pid && event.tid === start.tid)) throw new Error('Layout trace markers must share a renderer main thread.')
  const window = { startUs: start.ts, endUs: end.ts }
  validateWindow(window)
  return window
}

export function summarizeLayoutTrace(events: LayoutTraceEvent[], window: LayoutTraceWindow) {
  validateWindow(window)
  const threads = new Set(events.filter(event => event.name === 'thread_name' && event.args?.name === 'CrRendererMain').map(event => `${event.pid}:${event.tid}`))
  if (!threads.size) throw new Error('Trace has no renderer main-thread metadata.')
  const script = new Set(['FunctionCall', 'EvaluateScript', 'RunMicrotasks', 'EventDispatch', 'TimerFire', 'FireAnimationFrame'])
  const kinds = ['script', 'paint', 'style', 'layout'] as const
  const totals = { script: 0, style: 0, layout: 0, paint: 0 }
  let nestedLayout = 0; let maxTask = 0; let layoutCount = 0
  for (const thread of threads) {
    const selected = events.filter(event => `${event.pid}:${event.tid}` === thread && event.ph === 'X' && event.dur && event.dur > 0).flatMap(event => {
      const start = Math.max(event.ts, window.startUs)
      const end = Math.min(event.ts + event.dur!, window.endUs)
      return end > start ? [{ ...event, ts: start, dur: end - start }] : []
    })
    const edges: { at: number; kind: typeof kinds[number]; delta: number }[] = []
    for (const event of selected) {
      if (event.name.endsWith('RunTask')) maxTask = Math.max(maxTask, event.dur!)
      const kind = event.name === 'Layout' ? 'layout' : ['UpdateLayoutTree', 'RecalculateStyles'].includes(event.name) ? 'style'
        : ['Paint', 'PrePaint', 'Layerize', 'CompositeLayers'].includes(event.name) ? 'paint' : script.has(event.name) ? 'script' : null
      if (!kind) continue
      edges.push({ at: event.ts, kind, delta: 1 }, { at: event.ts + event.dur!, kind, delta: -1 })
      if (kind === 'layout') {
        layoutCount++
      }
    }
    const active = { script: 0, style: 0, layout: 0, paint: 0 }
    let previous = 0
    for (const edge of edges.sort((a, b) => a.at - b.at)) {
      const kind = [...kinds].reverse().find(kind => active[kind] > 0)
      if (kind) totals[kind] += edge.at - previous
      if (active.layout > 0 && active.script > 0) nestedLayout += edge.at - previous
      active[edge.kind] += edge.delta; previous = edge.at
    }
  }
  return { scriptMs: totals.script / 1000, styleMs: totals.style / 1000, layoutMs: totals.layout / 1000,
    paintMs: totals.paint / 1000, nestedLayoutMs: nestedLayout / 1000, maxTaskMs: maxTask / 1000, layoutCount }
}

export async function startLayoutTrace(page: Page) {
  const session = await page.context().newCDPSession(page)
  await session.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,toplevel,blink.user_timing', transferMode: 'ReturnAsStream' })
  return async (path: string) => {
    const complete = new Promise<string>(resolve => session.once('Tracing.tracingComplete', event => resolve(event.stream!)))
    try {
      await session.send('Tracing.end')
      const handle = await complete
      const file = await open(path, 'w')
      try {
        let eof = false
        while (!eof) {
          const chunk = await session.send('IO.read', { handle })
          await file.write(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'))
          eof = chunk.eof
        }
      } finally { await file.close(); await session.send('IO.close', { handle }) }
      const parsed: { traceEvents: LayoutTraceEvent[] } = JSON.parse(await readFile(path, 'utf8'))
      const window = profileTraceWindow(parsed.traceEvents)
      return { bytes: (await readFile(path)).length, events: parsed.traceEvents.length, window, pipeline: summarizeLayoutTrace(parsed.traceEvents, window) }
    } finally { await session.detach() }
  }
}
