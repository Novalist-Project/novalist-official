import assert from 'node:assert/strict'
import test from 'node:test'

const context = { workspaceId: 'workspace', workspaceEpoch: 2, bookId: 'book', draftId: 'draft' }
const filter = { status: '', character: '', location: '', plotline: '', stage: '' }
const scene = (id, order, extra = {}) => ({ id, order, stage: null, plotlineIds: [], ...extra })
const chapters = [
  { guid: 'second', order: 2, status: 'Draft', scenes: [scene('c', 0)] },
  { guid: 'first', order: 1, status: 'Final', scenes: [scene('b', 2), scene('a', 1, { stage: 'done', cast: ['character'] })] }
]
const projection = (extra = {}) => ({ context, scope: 'manuscript', anchor: null, selectedSceneIds: null, filter, ...extra })
const resolve = async (extra) => (await import('../src/renderer/src/stores/writingProjection.ts')).resolveWritingProjection(chapters, projection(extra))

test('null selection reads the manuscript in reading order; empty selection stays empty', async () => {
  assert.deepEqual((await resolve()).map(ref => ref.sceneId), ['a', 'b', 'c'])
  assert.deepEqual(await resolve({ selectedSceneIds: [] }), [])
  assert.deepEqual((await resolve({ selectedSceneIds: ['c', 'a'], filter: { ...filter, status: 'missing' } })).map(ref => ref.sceneId), ['a', 'c'])
})

test('scope respects its explicit anchor and rejects another book or draft', async () => {
  const anchor = { ...context, chapterGuid: 'first', sceneId: 'b' }
  assert.deepEqual((await resolve({ scope: 'chapter', anchor })).map(ref => ref.sceneId), ['a', 'b'])
  assert.deepEqual((await resolve({ scope: 'scene', anchor })).map(ref => ref.sceneId), ['b'])
  assert.deepEqual(await resolve({ scope: 'scene' }), [])
  assert.deepEqual(await resolve({ anchor: { ...anchor, draftId: 'other' } }), [])
})

test('filters combine and selected scenes override filters', async () => {
  assert.deepEqual((await resolve({ filter: { ...filter, status: 'final', stage: 'DONE', character: 'character' } })).map(ref => ref.sceneId), ['a'])
  assert.deepEqual(await resolve({ filter: { ...filter, location: 'elsewhere' } }), [])
  const withPov = [{ guid: 'pov', order: 0, status: 'Draft', scenes: [scene('pov-scene', 0, { pov: 'Mira' })] }]
  const { resolveWritingProjection } = await import('../src/renderer/src/stores/writingProjection.ts')
  assert.deepEqual(resolveWritingProjection(withPov, projection({ entityNames: { mira: 'Mira' }, filter: { ...filter, character: 'mira' } })).map(ref => ref.sceneId), ['pov-scene'])
})
