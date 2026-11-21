import assert from 'node:assert/strict'
import test from 'node:test'
import { describeShard, median, mergeTimings, planShards, specFilesFromList, timingsFromReports } from './e2e-shard.mjs'

const files = ['a.spec.ts', 'b.spec.ts', 'c.spec.ts', 'd.spec.ts', 'e.spec.ts', 'f.spec.ts', 'g.spec.ts']
const seconds = { 'a.spec.ts': 100, 'b.spec.ts': 60, 'c.spec.ts': 50, 'd.spec.ts': 40, 'e.spec.ts': 30, 'f.spec.ts': 10, 'g.spec.ts': 0 }

const everyFileOnce = (shards, expected) =>
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), [...expected].sort())

test('every file lands in exactly one shard and the load is balanced', () => {
  const shards = planShards(files, seconds, 3)
  everyFileOnce(shards, files)
  const loads = shards.map(shard => shard.seconds)
  assert.ok(Math.max(...loads) - Math.min(...loads) <= 50, `loads ${loads}`)
  assert.equal(loads.reduce((a, b) => a + b, 0), 290)
})

test('the plan is deterministic and independent of input order', () => {
  const first = planShards(files, seconds, 4)
  assert.deepEqual(planShards([...files].reverse(), seconds, 4), first)
  assert.deepEqual(planShards(files, { ...seconds }, 4), first)
})

test('files missing from the timings get the median duration', () => {
  assert.equal(median([10, 30, 20]), 20)
  assert.equal(median([10, 20, 30, 40]), 25)
  const unknown = [...files, 'new-1.spec.ts', 'new-2.spec.ts']
  const shards = planShards(unknown, seconds, 3)
  everyFileOnce(shards, unknown)
  assert.equal(shards.reduce((sum, shard) => sum + shard.seconds, 0), 290 + 2 * median(Object.values(seconds)))
})

test('an empty timings file still covers every file once', () => {
  assert.equal(median([]), 1)
  const shards = planShards(files, {}, 4)
  everyFileOnce(shards, files)
  assert.deepEqual(shards.map(shard => shard.files.length).sort(), [1, 2, 2, 2])
})

test('more shards than files leaves empty shards and still covers every file', () => {
  const shards = planShards(files.slice(0, 2), seconds, 4)
  everyFileOnce(shards, files.slice(0, 2))
  assert.equal(shards.filter(shard => shard.files.length === 0).length, 2)
})

test('duplicate files are planned once', () => {
  everyFileOnce(planShards([...files, ...files], seconds, 2), files)
})

test('spec files come from a nested list report once each', () => {
  const report = { suites: [{ specs: [{ file: 'b.spec.ts' }, { file: 'b.spec.ts' }], suites: [{ specs: [{ file: 'a.spec.ts' }] }] }, { specs: [{ file: 'a.spec.ts' }] }] }
  assert.deepEqual(specFilesFromList(report), ['a.spec.ts', 'b.spec.ts'])
})

const run = (file, project, ...durations) => ({
  title: file, file, specs: durations.map(duration => ({
    title: 't', file, tests: [{ projectName: project, results: [{ duration: 9000 }, { duration }] }]
  }))
})

test('timings sum the final attempt of each test of one project, later reports win', () => {
  const first = { suites: [run('a.spec.ts', 'app', 1500, 2500), run('b.spec.ts', 'writing-browser', 4000)] }
  const second = { suites: [run('a.spec.ts', 'app', 1000)] }
  assert.deepEqual(timingsFromReports([first], 'app'), { 'a.spec.ts': 4 })
  assert.deepEqual(timingsFromReports([first, second], 'app'), { 'a.spec.ts': 1 })
})

test('merging keeps files absent from the fresh data and sorts by name', () => {
  assert.deepEqual(Object.entries(mergeTimings({ 'z.spec.ts': 1, 'a.spec.ts': 2 }, { 'm.spec.ts': 3, 'a.spec.ts': 5 })),
    [['a.spec.ts', 5], ['m.spec.ts', 3], ['z.spec.ts', 1]])
})

test('the plan line shows file count and planned minutes', () => {
  assert.equal(describeShard(2, 4, { files: ['a', 'b'], seconds: 570 }), 'E2E shard 2/4: 2 files, planned 9.5 min')
})
