import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writingDiagnosticEvidence } from '../e2e/fixtures/writingDiagnosticEvidence.mts'

test('diagnostic evidence replaces authored strings without changing geometry or input', () => {
  const prose = 'synthetic \u00e9vidence'
  const signature = { sha256: createHash('sha256').update(prose).digest('hex'), characters: prose.length, utf8Bytes: Buffer.byteLength(prose) }
  const input = { result: { html: prose, nested: [{ text: prose, authored: prose }], geometry: { text: { top: 1, bottom: 4 } }, connected: true }, serialized: [prose, prose] }
  const before = structuredClone(input)
  const result = writingDiagnosticEvidence(input)
  assert.deepEqual(result, { result: { htmlEvidence: signature, nested: [{ textEvidence: signature, authoredEvidence: signature }], geometry: { text: { top: 1, bottom: 4 } }, connected: true }, serializedEvidence: [signature, signature] })
  assert.deepEqual(input, before)
  assert.equal(JSON.stringify(result).includes(prose), false)
  assert.deepEqual(writingDiagnosticEvidence({ serialized: prose }), { serializedEvidence: signature })
})

test('diagnostic evidence preserves metadata including authored source digests', () => {
  const digest = '870d7211ac9e09d8f990520a7b4c5ece87bc2c4e19e084ed159050f092bb1c7b'
  const input = { variantSourceSha256: { authored: digest }, provenance: { authored: digest }, workload: { authored: digest },
    before: { html: 'sample' }, first: { text: 'sample' }, second: { text: 'sample' }, samples: [{ html: 'sample' }] }
  const output = writingDiagnosticEvidence(input)
  for (const key of ['variantSourceSha256', 'provenance', 'workload']) assert.equal(JSON.stringify(output[key]), JSON.stringify(input[key]))
  assert.equal(output.variantSourceSha256.authored, digest)
  for (const key of ['before', 'first', 'second', 'samples']) assert.equal(JSON.stringify(output[key]).includes('sample'), false)
  const summary = { variantSourceSha256: { authored: digest }, records: [{ value: input }] }
  assert.deepEqual(writingDiagnosticEvidence(summary), summary)
})

test('adapter after, undo, redo and publication payloads cannot bypass authored-text redaction', () => {
  const prose = 'synthetic artifact payload'
  const input = { after: [{ output: [{ html: prose, text: prose }], deltas: [[{ insert: prose }]] }],
    undone: [{ html: prose }], redone: [{ text: prose }], publications: [{ plainText: prose, html: prose }] }
  const result = writingDiagnosticEvidence(input)
  assert.equal(JSON.stringify(result).includes(prose), false)
  assert.equal(result.after[0].output[0].htmlEvidence.characters, prose.length)
  assert.equal(result.publications[0].plainTextEvidence.characters, prose.length)
})

test('rich path attribute values are content evidence while opaque IDs and attribute names survive', () => {
  const attributes = { title: 'synthetic authored title', style: 'display:inline' }
  const output = writingDiagnosticEvidence({ result: { paths: [{ id: 'opaque-id', tag: 'p', attributes }], shape: { attributes: ['title', 'style'] } }, provenance: { attributes } })
  assert.equal(JSON.stringify(output.result).includes(attributes.title), false)
  assert.equal(output.result.paths[0].id, 'opaque-id')
  assert.equal(output.result.paths[0].attributesEvidence.sha256, createHash('sha256').update(JSON.stringify(attributes)).digest('hex'))
  assert.deepEqual(output.result.shape.attributes, ['title', 'style'])
  assert.deepEqual(output.provenance.attributes, attributes)
})
