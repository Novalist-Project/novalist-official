import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { readFileSync } from 'node:fs'
import { createLayoutTelemetry } from '../e2e/fixtures/writingLayoutTelemetry.ts'
import { instrumentBodies, profileWritingSource, layoutSourceNames } from '../e2e/fixtures/writingLayoutSource.ts'
import { summarizeLayoutTrace } from '../e2e/fixtures/writingLayoutTrace.ts'

test('nested spans subtract child duration and retain numeric counters', () => {
  let time = 0
  const telemetry = createLayoutTelemetry(() => time)
  telemetry.start()
  const parent = telemetry.enter('parent')
  time = 2
  const child = telemetry.enter('child')
  time = 5
  telemetry.exit(child)
  telemetry.count('atoms', 4)
  time = 9
  telemetry.exit(parent)
  const result = telemetry.stop()
  assert.deepEqual(result.spans.parent, { count: 1, totalMs: 9, selfMs: 6, maxMs: 9, firstMs: 0, lastMs: 9 })
  assert.deepEqual(result.spans.child, { count: 1, totalMs: 3, selfMs: 3, maxMs: 3, firstMs: 2, lastMs: 5 })
  assert.deepEqual(result.counters, { atoms: 4 })
})

test('instrumented bodies retain this, early returns and thrown error identity', () => {
  const source = 'class Owner { read(value) { if (value < 0) throw this.error; return this.base + value; } } globalThis.owner = new Owner();'
  const patched = instrumentBodies('fixture.js', source, ['Owner.read'])
  const telemetry = createLayoutTelemetry(() => 1)
  const context = { __writingLayout: telemetry }
  runInNewContext(patched, context)
  context.owner.base = 7
  context.owner.error = new Error('expected')
  telemetry.start()
  assert.equal(context.owner.read(3), 10)
  assert.throws(() => context.owner.read(-1), error => error === context.owner.error)
  assert.equal(telemetry.stop().spans['fixture.js:Owner.read'].count, 2)
})

test('missing and duplicate body seams fail instead of producing incomplete evidence', () => {
  assert.throws(() => instrumentBodies('fixture.js', 'function other() {}', ['read']), /read.*1.*0/)
  assert.throws(() => instrumentBodies('fixture.js', 'function read() {} function read() {}', ['read']), /read.*1.*2/)
})

test('measured expressions run once and preserve thrown errors', () => {
  const telemetry = createLayoutTelemetry(() => 1)
  telemetry.start()
  let calls = 0
  const value = { top: 120, bottom: 140 }
  assert.equal(telemetry.measure('read', () => { calls++; return value }), value)
  const failure = new Error('expected')
  assert.throws(() => telemetry.measure('read', () => { throw failure }), error => error === failure)
  assert.equal(calls, 1)
  assert.equal(telemetry.stop().spans.read.count, 2)
})

test('all declared seams match the current engine and fixture source', () => {
  for (const name of layoutSourceNames) {
    const directory = name.endsWith('.js') ? '../src/renderer/public/editor/'
      : ['sceneMarkup.ts', 'richText.ts'].includes(name) ? '../src/renderer/src/collaboration/' : '../e2e/fixtures/'
    assert.doesNotThrow(() => profileWritingSource(name, readFileSync(new URL(directory + name, import.meta.url), 'utf8')), name)
  }
})

test('trace accounting excludes nested layout and style from inclusive script duration', () => {
  const event = (name, ts, dur) => ({ name, ph: 'X', pid: 1, tid: 2, ts, dur })
  const result = summarizeLayoutTrace([
    { name: 'thread_name', ph: 'M', pid: 1, tid: 2, ts: 0, args: { name: 'CrRendererMain' } },
    event('FunctionCall', 0, 10000), event('FunctionCall', 1000, 8000),
    event('UpdateLayoutTree', 2000, 1000), event('Layout', 3000, 4000),
    event('Paint', 10000, 2000), event('RunTask', 0, 12000)
  ])
  assert.deepEqual(result, { scriptMs: 5, styleMs: 1, layoutMs: 4, paintMs: 2, nestedLayoutMs: 4, maxTaskMs: 12, layoutCount: 1 })
})

test('anchor probe preserves the same rect and counts only already measured offscreen anchors', () => {
  const telemetry = createLayoutTelemetry(() => 1)
  telemetry.start()
  const rect = { top: 120, bottom: 140 }
  let reads = 0
  assert.equal(telemetry.rect('anchor', () => { reads++; return rect }, 100), rect)
  telemetry.rect('anchor', () => ({ top: 2, bottom: 5 }), 100)
  assert.equal(reads, 1)
  assert.deepEqual(telemetry.stop().counters, { 'anchor.reads': 2, 'anchor.offscreen': 1 })
})
