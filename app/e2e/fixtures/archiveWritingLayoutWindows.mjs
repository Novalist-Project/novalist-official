import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { profileTraceWindow, summarizeLayoutTrace } from './writingLayoutTrace.ts'

const [root, originalPath, destination] = process.argv.slice(2)
assert.ok(root && originalPath && destination, 'Expected raw trace root, original archive and derived destination.')
const originalBytes = await readFile(originalPath)
const original = JSON.parse(originalBytes)
const directories = new Map()
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const directory = join(root, entry.name)
  const record = JSON.parse(await readFile(join(directory, 'layout-profile.json'), 'utf8'))
  assert.ok(!directories.has(record.sceneCount), 'Duplicate scene-count record.')
  directories.set(record.sceneCount, { directory, record })
}
assert.deepEqual(original.records.map(record => record.sceneCount), [100, 1000])
const records = []
for (const measured of original.records) {
  const source = directories.get(measured.sceneCount)
  assert.ok(source)
  assert.deepEqual(source.record, measured)
  const derived = structuredClone(measured)
  for (const mode of derived.modes) {
    const bytes = await readFile(join(source.directory, mode.name + '-trace.json'))
    const trace = JSON.parse(bytes)
    assert.equal(bytes.length, mode.trace.bytes)
    assert.equal(trace.traceEvents.length, mode.trace.events)
    const window = profileTraceWindow(trace.traceEvents)
    mode.trace = { ...mode.trace, fullStreamPipeline: mode.trace.pipeline, window,
      rawTraceSha256: createHash('sha256').update(bytes).digest('hex'), pipeline: summarizeLayoutTrace(trace.traceEvents, window) }
  }
  records.push(derived)
}
const files = ['e2e/fixtures/writingLayoutTrace.ts', 'e2e/fixtures/archiveWritingLayoutWindows.mjs']
const hash = createHash('sha256')
for (const file of files) { hash.update(file); hash.update('\0'); hash.update(await readFile(file)); hash.update('\0') }
const postprocessor = { algorithm: 'renderer-profile-mark-window-v2', sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain', '--', ...files], { encoding: 'utf8' }).trim().length > 0, sourceSha256: hash.digest('hex') }
assert.equal(postprocessor.sourceDirty, false, 'Commit the postprocessor before deriving provenance-tagged evidence.')
const archive = { kind: 'marker-windowed-derived-diagnostic-only', originalArchiveSha256: createHash('sha256').update(originalBytes).digest('hex'), postprocessor, records }
await writeFile(destination, JSON.stringify(archive, null, 2) + '\n')
const written = await readFile(destination)
assert.deepEqual(JSON.parse(written), archive)
assert.deepEqual(await readFile(originalPath), originalBytes)
console.log(JSON.stringify({ records: records.length, traces: records.reduce((sum, record) => sum + record.modes.length, 0), bytes: written.length,
  sha256: createHash('sha256').update(written).digest('hex'), postprocessor, verified: true }))
