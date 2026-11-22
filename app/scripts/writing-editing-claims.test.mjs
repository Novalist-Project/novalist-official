import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { loadRendererSource } from './renderer-source-loader.mjs'

const require = createRequire(import.meta.url), Y = require('yjs')
const compiled = await build({ stdin: { contents: "export * from './src/renderer/src/stores/writingDocuments'; export * from './src/renderer/src/collaboration/SharedSceneSession'; export * from './src/renderer/src/collaboration/sharedWritingAnnotations'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' })
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports)
const context = { workspaceId: '/synthetic/project', workspaceEpoch: 3, bookId: 'book', draftId: 'draft' }
const ref = (sceneId, bookId = 'book') => ({ bookId, draftId: 'draft', chapterGuid: 'chapter', sceneId })
const emptyAnnotations = { comments: [], footnotes: [] }

function fixture(t) {
  const dom = new JSDOM('')
  const sessions = new Map(), registries = [], pending = [], reports = []
  let fail = false, held = false, focused = true
  let send = async () => undefined
  let state = { projectPath: context.workspaceId, workspaceEpoch: 3, activeBookId: 'book', activeDraftId: 'draft',
    isLoaded: true, workspaceSuspended: false, editors: {}, chapters: [] }
  const annotations = new module.exports.SharedWritingAnnotations(async request => {
    if (fail) throw new Error('offline')
    return { status: 'committed', operationId: request.transactionId,
      annotations: request.changes.map(change => ({ ref: change.ref, annotations: change.after })) }
  })
  const { WritingEditingClaims } = loadRendererSource('src/stores/writingEditingClaims.ts', {
    './writingDocuments': module.exports,
    '../collaboration/sharedWritingSessions': {
      findSharedWritingSession: identity => sessions.get(identity.itemId),
      observeSharedWritingSession: (identity, changed) => sessions.get(identity.itemId).observe(changed)
    },
    '../collaboration/sharedWritingAnnotations': { findSharedWritingAnnotations: () => annotations }
  })
  const claims = new WritingEditingClaims()
  const reporter = loadRendererSource('src/stores/projectPersistence.ts', {
    '../rpc/client': { rpc: { request: async (method, args) => { reports.push({ method, args: structuredClone(args) }); await send() } } },
    './projectStore': { useProjectStore: { getState: () => state }, mirror: () => ({}) }, './sceneWriteQueue': {},
    '../collaboration/sharedEditors': {}, './writingEditingClaims': { writingEditingClaims: claims }
  }, { window: { novalist: { isMobile: false }, document: { hasFocus: () => focused } } })
  const registry = (bookId = 'book', shared = false) => {
    const owner = new module.exports.WritingDocumentRegistry({ context: { ...context, bookId }, isCurrent: () => true,
      transport: { read: async target => ({ html: 'Base', hash: 'base', annotations: emptyAnnotations,
        shared: shared ? { sessionId: 'session', itemId: target.sceneId, state: '' } : null }), activate: async () => true,
      commit: async request => {
        if (fail) throw new Error('offline')
        if (held) await new Promise(resolve => pending.push(resolve))
        return { status: 'committed', operationId: request.transactionId, hashes: request.changes.map(change => ({ ref: change.ref, hash: 'saved' })) }
      } } })
    registries.push(owner); claims.track(owner); return owner
  }
  const sharedOwner = id => {
    const doc = new Y.Doc(), prose = doc.getText('prose')
    prose.insert(0, 'Base'); prose.insert(4, '\n', { block: JSON.stringify([{ id: 'paragraph', tag: 'p', attributes: {} }]) })
    const owner = new module.exports.SharedSceneSession({ document: dom.window.document, toDisplayImages() {}, sanitizeSceneFragment(html) {
      const template = dom.window.document.createElement('template'); template.innerHTML = html; return template.content
    } }, Y.encodeStateAsUpdate(doc), { read: async () => Y.encodeStateAsUpdate(doc), subscribe: () => () => {}, write: async update => {
      if (fail) throw new Error('offline'); Y.applyUpdate(doc, update)
    } })
    sessions.set(id, owner); t.after(() => doc.destroy()); return owner
  }
  t.after(async () => {
    fail = false; held = false; pending.splice(0).forEach(resolve => resolve())
    await annotations.flush()
    for (const owner of registries) await owner.close()
    for (const owner of sessions.values()) await owner.close()
    dom.window.close()
  })
  const edit = (owner, target, html) => {
    const before = owner.getSnapshot(target)
    owner.apply({ id: crypto.randomUUID(), context: owner.context, origin: 'writer', kind: 'input',
      changes: [{ ref: target, expectedRevision: before.revision, beforeHtml: before.html, afterHtml: html }],
      annotationChanges: [], beforeSelection: null, afterSelection: null })
  }
  return { claims, reports, registry, sharedOwner, annotations, edit, pending,
    transport: next => { send = next },
    report: () => reporter.reportEditingScenes(), force: () => reporter.reportEditingScenes(true),
    state: patch => { state = { ...state, ...patch }; reporter.reportEditingScenes() },
    focused: value => { focused = value; reporter.reportEditingScenes() },
    fail: value => { fail = value }, hold: value => { held = value },
    current: () => JSON.parse(JSON.stringify(claims.read({ ...context, bookId: state.activeBookId, draftId: state.activeDraftId,
      workspaceId: state.projectPath, workspaceEpoch: state.workspaceEpoch }, focused))) }
}

test('canonical claims retain offscreen dirty scenes, report only native active clean scenes, and ignore legacy false flags', async t => {
  const f = fixture(t), owner = f.registry()
  await owner.read(ref('first')); await owner.read(ref('second'))
  assert.deepEqual(f.current(), [])
  f.claims.focus('pane', owner, ref('first'))
  assert.deepEqual(f.current(), [{ chapterGuid: 'chapter', sceneId: 'first', dirty: false }])
  f.state({ editors: { pane: { chapterGuid: 'chapter', sceneId: 'first', isDirty: false } } })
  f.edit(owner, ref('first'), 'Pending')
  f.claims.focus('pane', owner, ref('second'))
  assert.deepEqual(f.current(), [{ chapterGuid: 'chapter', sceneId: 'first', dirty: true }, { chapterGuid: 'chapter', sceneId: 'second', dirty: false }])
  f.focused(false)
  assert.deepEqual(f.current(), [{ chapterGuid: 'chapter', sceneId: 'first', dirty: true }])
  assert.equal(f.reports.at(-1).args[2], true)
  await owner.flush()
  assert.deepEqual(f.current(), [])
  assert.deepEqual(f.reports.at(-1).args, [null, null, false])
})

test('canonical claims do not rescan a loaded book or repeat RPC for every dirty keystroke or metadata refresh', async t => {
  const f = fixture(t), owner = f.registry()
  let captures = 0
  const capture = owner.capture.bind(owner)
  owner.capture = () => { captures++; return capture() }
  for (let i = 0; i < 1000; i++) await owner.read(ref(String(i)))
  const before = captures
  f.edit(owner, ref('500'), 'First')
  const sent = f.reports.length
  for (let i = 0; i < 50; i++) {
    f.edit(owner, ref('500'), `More ${i}`)
    f.state({ chapters: [{ guid: 'chapter', title: `Metadata ${i}` }] })
  }
  assert.equal(captures, before)
  assert.equal(f.reports.length, sent)
  assert.deepEqual(f.current(), [{ chapterGuid: 'chapter', sceneId: '500', dirty: true }])
})

test('an old save acknowledgement cannot release a newer edit and a refused close retains its claim', async t => {
  const f = fixture(t), owner = f.registry()
  await owner.read(ref('first')); f.edit(owner, ref('first'), 'First')
  f.hold(true)
  const saving = owner.flush()
  f.edit(owner, ref('first'), 'Second')
  f.pending.shift()(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.current()[0].dirty, true)
  f.hold(false); f.pending.shift()(); await saving
  assert.deepEqual(f.current(), [])
  f.fail(true); f.edit(owner, ref('first'), 'Refused')
  await assert.rejects(owner.close(), /offline/)
  assert.equal(f.current()[0].dirty, true)
  f.fail(false); await owner.close()
  assert.deepEqual(f.current(), [])
})

test('shared prose and annotation queues protect offscreen scenes independently of canonical HTML dirtiness', async t => {
  const f = fixture(t), shared = f.sharedOwner('shared'), owner = f.registry('book', true)
  await owner.read(ref('shared'))
  f.fail(true); shared.transact(prose => prose.insert(4, ' local'))
  await assert.rejects(shared.flush())
  assert.equal(owner.isDirty, false)
  assert.deepEqual(f.current(), [{ chapterGuid: 'chapter', sceneId: 'shared', dirty: true }])
  f.annotations.accept('annotations', [{ registry: owner, change: { ref: ref('shared'), before: emptyAnnotations,
    after: { comments: [], footnotes: [{ id: 'note', number: 1, text: 'Pending note' }] } } }])
  f.fail(false); await shared.flush()
  assert.equal(f.current()[0].dirty, true)
  await f.annotations.flush()
  assert.deepEqual(f.current(), [])
})

test('claims use full active workspace book draft epoch and old focus cleanup cannot release the current pane', async t => {
  const f = fixture(t), first = f.registry(), other = f.registry('other')
  await first.read(ref('same')); await other.read(ref('same', 'other'))
  f.edit(first, ref('same'), 'Book pending')
  f.claims.focus('first-pane', first, ref('same'))
  f.claims.focus('second-pane', other, ref('same', 'other'))
  f.claims.blur('first-pane')
  f.state({ activeBookId: 'other' })
  assert.deepEqual(f.current(), [{ chapterGuid: 'chapter', sceneId: 'same', dirty: false }])
  for (const patch of [{ activeDraftId: 'different' }, { activeDraftId: 'draft', workspaceEpoch: 4 },
    { workspaceEpoch: 3, projectPath: '/different' }]) {
    f.state(patch); assert.deepEqual(f.current(), []); assert.deepEqual(f.reports.at(-1).args, [null, null, false])
  }
  f.state({ projectPath: context.workspaceId, activeBookId: 'book' })
  assert.equal(f.current()[0].dirty, true)
})

test('late rejected reports cannot invalidate newer acknowledgements and current failures retry without dropping claims', async t => {
  const f = fixture(t), owner = f.registry()
  await owner.read(ref('first'))
  let rejectOld
  f.transport(() => new Promise((resolve, reject) => { rejectOld = reject }))
  f.edit(owner, ref('first'), 'Pending')
  f.transport(async () => undefined)
  f.force()
  const sent = f.reports.length
  rejectOld(new Error('old report lost')); await new Promise(resolve => setImmediate(resolve))
  f.report()
  assert.equal(f.reports.length, sent)
  f.transport(async () => { throw new Error('current report refused') })
  f.force(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.current()[0].dirty, true)
  f.transport(async () => undefined); f.edit(owner, ref('first'), 'Retry reporting on the next edit')
  assert.equal(f.reports.length, sent + 2)
  assert.equal(f.reports.at(-1).args[2], true)
  f.state({ workspaceSuspended: true })
  f.edit(owner, ref('first'), 'Newer while suspended')
  assert.equal(f.reports.length, sent + 2)
  f.state({ workspaceSuspended: false, workspaceEpoch: 4 })
  assert.deepEqual(f.reports.at(-1).args, [null, null, false])
})
