import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import * as Y from 'yjs'

assert.deepEqual(process.argv.slice(2), ['--assert-preservation'], 'Opt in with --assert-preservation; this diagnostic asserts the unimplemented hard contract.')

const require = createRequire(import.meta.url)
const source = new URL('../src/renderer/src/collaboration/richText.ts', import.meta.url)
const bundle = await build({ entryPoints: [fileURLToPath(source)], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, { require, module, exports: module.exports }, { filename: fileURLToPath(source) })
const { updateRichText } = module.exports

// Proposed test-only encoding: the descriptor exists only while C is empty.
const identity = 'inline-c'
const descriptorKey = 'emptyInline:v1'
const markKey = `span:${identity}`
const attributesA = { style: 'display:inline-block;width:16px;border:1px solid black' }
const attributesB = { style: 'display:inline-block;width:24px;border:2px solid black' }
const filledText = 'x'
const digest = value => createHash('sha256').update(value).digest('hex')
const descriptor = attributes => JSON.stringify({ id: identity, tag: 'span', attributes })
const empty = attributes => [{ insert: '\uFFFC', attributes: { [descriptorKey]: descriptor(attributes) } }]
const filled = attributes => [{ insert: filledText, attributes: { [markKey]: JSON.stringify(attributes) } }]
const canonical = runs => runs.map(run => ({ insert: run.insert, attributes: Object.fromEntries(Object.entries(run.attributes ?? {}).sort(([a], [b]) => a.localeCompare(b))) }))
const stateHash = runs => digest(JSON.stringify(canonical(runs)))

function shape(runs) {
  return {
    hash: stateHash(runs), runs: runs.length,
    units: runs.reduce((sum, run) => sum + run.insert.length, 0),
    markerUnits: runs.reduce((sum, run) => sum + [...run.insert].filter(char => char === '\uFFFC').length, 0),
    marks: runs.map(run => Object.entries(run.attributes ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, hash: digest(value) })))
  }
}

function pair() {
  const docs = [new Y.Doc(), new Y.Doc()]
  docs[0].clientID = 101
  docs[1].clientID = 202
  const texts = docs.map(doc => doc.getText('prose'))
  const origins = [{}, {}], remote = {}, operations = []
  docs[0].transact(() => updateRichText(texts[0], empty(attributesA)))
  Y.applyUpdate(docs[1], Y.encodeStateAsUpdate(docs[0]), remote)
  const histories = texts.map((text, index) => new Y.UndoManager(text, { trackedOrigins: new Set([origins[index]]), captureTimeout: 0 }))
  texts.forEach((text, index) => text.observe((event, transaction) => {
    const origin = transaction.origin === origins[index] ? 'local' : transaction.origin === remote ? 'remote' : transaction.origin === histories[index] ? 'history' : 'other'
    operations.push({ writer: index, origin, delta: event.delta.map(change => ({
      ...(change.insert === undefined ? {} : { insertUnits: change.insert.length, insertHash: digest(change.insert) }),
      ...(change.delete === undefined ? {} : { deleteUnits: change.delete }),
      ...(change.retain === undefined ? {} : { retainUnits: change.retain }),
      ...(change.attributes === undefined ? {} : { attributes: Object.entries(change.attributes).map(([key, value]) => ({ key, hash: digest(JSON.stringify(value)) })) })
    })) })
  }))
  return {
    docs, texts, histories, operations,
    change(index, runs) { docs[index].transact(() => updateRichText(texts[index], runs), origins[index]) },
    apply(index, update) { Y.applyUpdate(docs[index], update, remote) },
    sync(index) { this.apply(1 - index, Y.encodeStateAsUpdate(docs[index], Y.encodeStateVector(docs[1 - index]))) },
    close() { histories.forEach(history => history.destroy()); docs.forEach(doc => doc.destroy()) }
  }
}

function merge(fixture, order, fill, format) {
  const vectors = fixture.docs.map(doc => Y.encodeStateVector(doc))
  if (fill) fixture.change(0, filled(attributesA))
  if (format) fixture.change(1, empty(attributesB))
  assert.deepEqual(fixture.histories.map(history => history.undoStack.length), [Number(fill), Number(format)])
  const updates = fixture.docs.map((doc, index) => Y.encodeStateAsUpdate(doc, vectors[index]))
  for (const index of order) fixture.apply(1 - index, updates[index])
  assert.deepEqual(fixture.histories.map(history => history.undoStack.length), [Number(fill), Number(format)], 'Remote delivery must not join local history')
  return updates.map(update => ({ bytes: update.length, hash: digest(update) }))
}

function assertPeers(fixture, expected) {
  assert.equal(stateHash(fixture.texts[0].toDelta()), stateHash(fixture.texts[1].toDelta()), 'Peers must converge')
  for (const text of fixture.texts) assert.equal(stateHash(text.toDelta()), stateHash(expected), 'Retained-wrapper attributes and children must survive')
}

function control(kind, order) {
  const fixture = pair()
  const fill = kind === 'fill-only', owner = fill ? 0 : 1
  try {
    const updates = merge(fixture, order, fill, !fill)
    const expected = fill ? filled(attributesA) : empty(attributesB)
    assertPeers(fixture, expected)
    fixture.histories[owner].undo()
    fixture.sync(owner)
    assertPeers(fixture, empty(attributesA))
    fixture.histories[owner].redo()
    fixture.sync(owner)
    assertPeers(fixture, expected)
    assert.deepEqual(fixture.histories.map(history => history.undoStack.length), fill ? [1, 0] : [0, 1])
    return { kind, order, assertions: 'PASS', updates, state: shape(fixture.texts[0].toDelta()), operations: fixture.operations }
  } finally { fixture.close() }
}

const failures = []
function observeContract(fixture, stage, expected, observations) {
  assert.equal(stateHash(fixture.texts[0].toDelta()), stateHash(fixture.texts[1].toDelta()), 'Peers must converge independently of preservation')
  const actual = fixture.texts[0].toDelta()
  const preserved = stateHash(actual) === stateHash(expected)
  observations.push({ stage, preserved, actual: shape(actual), expected: shape(expected), histories: fixture.histories.map(history => ({ undo: history.undoStack.length, redo: history.redoStack.length })) })
  if (!preserved) failures.push(stage)
}

function race(order, owner) {
  const fixture = pair(), observations = []
  const label = `${order.join('-')}:${owner === 0 ? 'fill' : 'format'}`
  try {
    const updates = merge(fixture, order, true, true)
    observeContract(fixture, `${label}:merge`, filled(attributesB), observations)
    fixture.histories[owner].undo()
    fixture.sync(owner)
    assert.deepEqual(fixture.histories.map(history => history.undoStack.length), owner === 0 ? [0, 1] : [1, 0])
    observeContract(fixture, `${label}:undo`, owner === 0 ? empty(attributesB) : filled(attributesA), observations)
    fixture.histories[owner].redo()
    fixture.sync(owner)
    assert.deepEqual(fixture.histories.map(history => history.undoStack.length), [1, 1])
    observeContract(fixture, `${label}:redo`, filled(attributesB), observations)
    return { order, historyOwner: owner, updates, observations, operations: fixture.operations }
  } finally { fixture.close() }
}

const start = performance.now()
const orders = [[0, 1], [1, 0]]
// Controls fail immediately; a broken fixture must not be reported as architecture evidence.
const controls = orders.flatMap(order => ['format-only', 'fill-only'].map(kind => control(kind, order)))
const races = orders.flatMap(order => [0, 1].map(owner => race(order, owner)))
const identities = {
  base: '00fa4f40bd6cc392f6fb5b4aee52a0fd784d48ad', node: process.version,
  yjs: require('yjs/package.json').version, diff: require('diff/package.json').version,
  esbuild: require('esbuild/package.json').version,
  source: digest(readFileSync(source)), script: digest(readFileSync(new URL(import.meta.url))),
  lockfile: digest(readFileSync(new URL('../package-lock.json', import.meta.url)))
}
console.log(JSON.stringify({ identities, run: digest(JSON.stringify(identities)), controls, races,
  failedContractAssertions: failures.length, failures, elapsedMs: performance.now() - start, rssBytes: process.memoryUsage().rss }))
assert.equal(failures.length, 0, `Inline format/fill preservation contract failed at ${failures.join(', ')}`)
