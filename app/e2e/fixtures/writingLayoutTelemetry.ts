export interface LayoutSnapshot {
  elapsedMs: number
  lastActivityMs: number
  spans: Record<string, { count: number; totalMs: number; selfMs: number; maxMs: number; firstMs: number; lastMs: number }>
  counters: Record<string, number>
}

export function createLayoutTelemetry(now: () => number = () => performance.now()) {
  interface Span { name: string; start: number; children: number }
  let active = false
  let start = 0
  let lastActivity = 0
  let spans: LayoutSnapshot['spans'] = {}
  let counters: Record<string, number> = {}
  const stack: Span[] = []
  const telemetry = {
    start() {
      if (stack.length) throw new Error('Cannot reset an active layout span.')
      spans = {}; counters = {}; start = now(); lastActivity = start; active = true
    },
    enter(name: string): Span | null {
      if (!active) return null
      const span = { name, start: now(), children: 0 }
      stack.push(span)
      return span
    },
    exit(span: Span | null) {
      if (!span) return
      if (stack.pop() !== span) throw new Error('Layout telemetry nesting mismatch.')
      lastActivity = now()
      const elapsed = lastActivity - span.start
      const result = spans[span.name] ??= { count: 0, totalMs: 0, selfMs: 0, maxMs: 0, firstMs: span.start - start, lastMs: 0 }
      result.count++; result.totalMs += elapsed; result.selfMs += elapsed - span.children
      result.maxMs = Math.max(result.maxMs, elapsed)
      result.lastMs = lastActivity - start
      if (stack.length) stack[stack.length - 1].children += elapsed
    },
    count(name: string, value = 1) { if (active) counters[name] = (counters[name] ?? 0) + value },
    measure<T>(name: string, read: () => T): T {
      const span = telemetry.enter(name)
      try { return read() } finally { telemetry.exit(span) }
    },
    value<T extends string | ArrayLike<unknown>>(name: string, value: T): T {
      telemetry.count(name, value.length)
      return value
    },
    rect<T extends { top: number; bottom: number }>(name: string, read: () => T, viewportHeight: number): T {
      const rect = telemetry.measure(name, read)
      telemetry.count(name + '.reads')
      if (rect.bottom < 0 || rect.top > viewportHeight) telemetry.count(name + '.offscreen')
      return rect
    },
    stop(): LayoutSnapshot {
      if (stack.length) throw new Error('Cannot stop within an active layout span.')
      active = false
      return { elapsedMs: now() - start, lastActivityMs: lastActivity - start, spans, counters }
    }
  }
  return telemetry
}

declare global { interface Window { __writingLayout: ReturnType<typeof createLayoutTelemetry> } }
