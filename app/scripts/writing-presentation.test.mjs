import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import * as presentation from '../src/renderer/src/views/editor/writingPresentation.ts'
import { synopsisExpanded, setSynopsisExpanded, synopsisVisibilityKey, writingPresentationKey } from '../src/renderer/src/views/editor/writingPresentation.ts'

test('synopsis expansion starts collapsed and belongs to the complete writer-local scene identity', () => {
  const values = new Map()
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const context = { workspaceId: 'project', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
  const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
  assert.equal(synopsisExpanded(context, ref), false)
  setSynopsisExpanded(context, ref, true)
  assert.equal(synopsisExpanded(context, ref), true)
  assert.equal(synopsisExpanded({ ...context, workspaceId: 'other' }, ref), false)
  assert.equal(synopsisExpanded(context, { ...ref, draftId: 'other' }), false)
  assert.equal(synopsisExpanded({ ...context, workspaceEpoch: 2 }, ref), true)
  assert.equal(synopsisVisibilityKey(context), synopsisVisibilityKey({ ...context, bookId: 'other' }))
  assert.notEqual(writingPresentationKey(context, ref), writingPresentationKey(context, { ...ref, sceneId: 'other' }))
  assert.equal([...values.values()].some(value => value.includes('<p>')), false)
})

test('margin counts separate rich blocks and exclude only tracked deletions', () => {
  const dom = new JSDOM()
  const template = dom.window.document.createElement('template')
  template.innerHTML = '<h1>Heading</h1><p>Body</p><ul><li>First</li><li>Second</li></ul><table><tr><td>Left</td><td>Right</td></tr></table><p><del data-nl-change="cut">Removed</del><del>Struck</del> <ins data-nl-change="add">Added</ins></p>'
  const before = template.innerHTML
  assert.deepEqual(presentation.writingCountText(template.content).trim().split(/\s+/), ['Heading', 'Body', 'First', 'Second', 'Left', 'Right', 'Struck', 'Added'])
  assert.equal(template.innerHTML, before)
  dom.window.close()
})
