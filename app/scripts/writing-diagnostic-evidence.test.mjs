import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writingDiagnosticEvidence } from '../e2e/fixtures/writingDiagnosticEvidence.ts'

test('diagnostic evidence replaces authored strings without changing geometry or input', () => {
  const prose = 'synthetic \u00e9vidence'
  const signature = { sha256: createHash('sha256').update(prose).digest('hex'), characters: prose.length, utf8Bytes: Buffer.byteLength(prose) }
  const input = { html: prose, nested: [{ text: prose, authored: prose }], serialized: [prose, prose], geometry: { text: { top: 1, bottom: 4 } }, connected: true }
  const before = structuredClone(input)
  const result = writingDiagnosticEvidence(input)
  assert.deepEqual(result, { htmlEvidence: signature, nested: [{ textEvidence: signature, authoredEvidence: signature }], serializedEvidence: [signature, signature], geometry: { text: { top: 1, bottom: 4 } }, connected: true })
  assert.deepEqual(input, before)
  assert.equal(JSON.stringify(result).includes(prose), false)
  assert.deepEqual(writingDiagnosticEvidence({ serialized: prose }), { serializedEvidence: signature })
})
