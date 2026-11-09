import type { Page } from '@playwright/test'
import { open, readFile } from 'node:fs/promises'

export interface LayoutTraceEvent { name: string; ph: string; pid: number; tid: number; ts: number; dur?: number; args?: { name?: string } }

export function summarizeLayoutTrace(events: LayoutTraceEvent[]) {
  const threads = new Set(events.filter(event => event.name === 'thread_name' && event.args?.name === 'CrRendererMain').map(event => `${event.pid}:${event.tid}`))
  if (!threads.size) throw new Error('Trace has no renderer main-thread metadata.')
  const script = new Set(['FunctionCall', 'EvaluateScript', 'RunMicrotasks', 'EventDispatch', 'TimerFire', 'FireAnimationFrame'])
  const kinds = ['script', 'paint', 'style', 'layout'] as const
  const totals = { script: 0, style: 0, layout: 0, paint: 0 }
  let nestedLayout = 0; let maxTask = 0; let layoutCount = 0
  for (const thread of threads) {
    const selected = events.filter(event => `${event.pid}:${event.tid}` === thread && event.ph === 'X' && event.dur)
    const edges: { at: number; kind: typeof kinds[number]; delta: number }[] = []
    const scripts = selected.filter(event => script.has(event.name))
    for (const event of selected) {
      if (event.name.endsWith('RunTask')) maxTask = Math.max(maxTask, event.dur!)
      const kind = event.name === 'Layout' ? 'layout' : ['UpdateLayoutTree', 'RecalculateStyles'].includes(event.name) ? 'style'
        : ['Paint', 'PrePaint', 'Layerize', 'CompositeLayers'].includes(event.name) ? 'paint' : script.has(event.name) ? 'script' : null
      if (!kind) continue
      edges.push({ at: event.ts, kind, delta: 1 }, { at: event.ts + event.dur!, kind, delta: -1 })
      if (kind === 'layout') {
        layoutCount++
        if (scripts.some(parent => parent.ts <= event.ts && parent.ts + parent.dur! >= event.ts + event.dur!)) nestedLayout += event.dur!
      }
    }
    const active = { script: 0, style: 0, layout: 0, paint: 0 }
    let previous = 0
    for (const edge of edges.sort((a, b) => a.at - b.at)) {
      const kind = [...kinds].reverse().find(kind => active[kind] > 0)
      if (kind) totals[kind] += edge.at - previous
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
      return { bytes: (await readFile(path)).length, events: parsed.traceEvents.length, pipeline: summarizeLayoutTrace(parsed.traceEvents) }
    } finally { await session.detach() }
  }
}
