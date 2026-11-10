import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { WritingFocusOwner } from '../src/main/writing-focus.ts'

const directory = fileURLToPath(new URL('..', import.meta.url))
const sources = {
  writingEditingClaims: `export const writingEditingClaims = { focus: (source, registry, ref) => globalThis.editingClaims.push(ref.sceneId), blur() {} };`,
  WritingSharedPresence: `export class WritingSharedPresence { update() {} close() {} }`,
  projectStore: `const state = { editors: {}, setContextScene() {} }; export const editorPane = () => ({});
    export const useProjectStore = { getState: () => state, setState: update => Object.assign(state, update(state)) };`,
  shellStore: `export const useShellStore = { getState: () => ({ setActivePane() {} }) };`,
  writingHistory: `export const acceptSharedWritingTransaction = () => {}; export const acceptWritingTransaction = () => {}; export const getWritingHistory = () => {};`,
  sharedWritingSessions: `export const createSharedWritingBinding = () => {}; export const getSharedWritingSession = () => {};`,
  SharedWritingHistory: `export class SharedWritingHistory {}`,
  sharedWritingAnnotations: `export const getSharedWritingAnnotations = () => ({ observe: () => () => {} }); export const refreshSharedWritingAnnotations = () => {};`,
  sharedProjectNotifications: `export const useSharedProjectRevision = { subscribe: () => () => {}, getState: () => 0 };`,
  writingNavigation: `export const registerWritingNavigation = () => () => {};`,
  writingAnnotationMessages: `export const applyWritingAnnotations = () => {}; export const handleWritingAnnotationMessage = () => false; export const pushWritingAnnotations = () => {};`
}
const result = await build({ entryPoints: [`${directory}/src/renderer/src/views/editor/writingPaneController.ts`],
  bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'controller-dependencies', setup(builder) {
    builder.onResolve({ filter: /./ }, args => {
      const key = args.path.split('/').at(-1)
      if (key in sources) return { path: key, namespace: 'fixture' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path] }))
  } }] })
const { WritingPaneController } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const settle = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  globalThis.editingClaims = []
  let focusedWindow = 1, focusedPane = 'a', backendScene = null, delayClaim = null, delayActivation = null
  const claims = [], activations = [], errors = []
  const focus = new WritingFocusOwner(async (method, params) => {
    claims.push(params)
    if (delayClaim) await delayClaim
  }, () => focusedWindow)
  globalThis.window = { novalist: { claimWritingFocus: (source, epoch) => focus.claim(focusedWindow, source, epoch) } }
  const pane = (id, owner) => {
    const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: id }
    const controller = new WritingPaneController(id, { ready() {}, selection() {}, projection() {}, error: error => errors.push(error), structure() {} })
    controller.registry = { context: { workspaceEpoch: 1 }, activate: async (ref, lease) => {
      if (delayActivation) await delayActivation
      activations.push({ scene: ref.sceneId, ...lease }); backendScene = ref.sceneId; return true
    } }
    controller.references.set(id, ref)
    controller.ready({ document: { hasFocus: () => focusedWindow === owner && focusedPane === id },
      configureWritingTextMapping() {}, setWritingContext() {}, setWritingStructureEnabled() {},
      getWritingSelection: () => ({ anchor: { sceneId: id, offset: 0 }, focus: { sceneId: id, offset: 0 } }),
      writingServiceState: () => null })
    return controller
  }
  return { pane, claims, activations, errors, backend: () => backendScene,
    focus: (id, owner) => { focusedPane = id; focusedWindow = owner },
    delayClaim: value => { delayClaim = value }, delayActivation: value => { delayActivation = value } }
}

for (const detached of [false, true]) test(`returning to ${detached ? 'a detached window' : 'a retained pane'} reclaims the unchanged scene`, async () => {
  const f = fixture(), a = f.pane('a', 1), b = f.pane('b', detached ? 2 : 1)
  a.message({ type: 'focused' }); await settle()
  for (let i = 0; i < 5; i++) a.message({ type: 'writingSelectionChanged' })
  await settle(); assert.equal(f.claims.length, 1)
  f.focus('b', detached ? 2 : 1); b.message({ type: 'focused' }); await settle()
  assert.equal(f.backend(), 'b')
  f.focus('a', 1); a.message({ type: 'focused' }); await settle()
  assert.equal(f.backend(), 'a'); assert.equal(f.claims.length, 3)
  assert.deepEqual(f.activations.map(item => item.scene), ['a', 'b', 'a'])
  assert.deepEqual(globalThis.editingClaims, ['a', 'b', 'a'])
  assert.deepEqual(f.errors, [])
})

test('a delayed claim from a blurred window cannot reactivate its old scene', async () => {
  const f = fixture(), a = f.pane('a', 1), b = f.pane('b', 2)
  let release
  f.delayClaim(new Promise(resolve => { release = resolve }))
  a.message({ type: 'focused' })
  f.delayClaim(null); f.focus('b', 2); b.message({ type: 'focused' }); await settle()
  release(); await settle()
  assert.deepEqual(f.activations.map(item => item.scene), ['b'])
  assert.deepEqual(globalThis.editingClaims, ['b'])
})

function projectionFixture(selection) {
  const calls = [], errors = []
  const roots = new Map(['first', 'second'].map((id, index) => [id, { isConnected: true,
    getBoundingClientRect: () => ({ top: index ? 300 : -500, bottom: index ? 900 : -100 }) }]))
  const refs = ['first', 'second'].map(sceneId => ({ bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId }))
  let domProjection = refs
  const controller = new WritingPaneController('pane', { ready() {}, selection() {}, projection() {}, structure() {}, error: reason => errors.push(reason) })
  controller.registry = { context: { workspaceEpoch: 1 } }
  controller.references = new Map(refs.map(ref => [ref.sceneId, ref]))
  controller.ready({ configureWritingTextMapping() {}, setWritingContext() {}, setWritingStructureEnabled() {},
    document: { getElementById: () => ({ getBoundingClientRect: () => ({ top: 100, bottom: 700 }) }),
      querySelectorAll: () => domProjection.map(ref => ({ dataset: { writingScene: ref.sceneId } })),
      createRange: () => { let point; return { setStart(node) { point = node }, collapse() {},
        getBoundingClientRect: () => ({ top: point.top, bottom: point.top + 20, height: 20 }) } } },
    writingDomPoint: point => ({ node: { top: roots.get(point.sceneId).getBoundingClientRect().top + 20 + point.offset }, offset: 0 }),
    getWritingSceneRoot: id => roots.get(id),
    captureWritingChanges: () => [], getWritingSelection: () => selection, writingServiceState: () => null,
    setWritingProjection(next) { domProjection = next }, focusEditor: () => calls.push('focus'),
    revealWritingPoint: (point, viewportOffset) => calls.push({ reveal: point, ...(viewportOffset !== undefined ? { viewportOffset } : {}) }),
    restoreWritingSelection: range => calls.push({ selection: range }) })
  controller.project(refs)
  return { controller, refs, calls, errors, roots, domProjection: refs => { domProjection = refs } }
}

test('Focus scene waits for projection application and preserves the caret range inside its target', () => {
  const selection = { anchor: { sceneId: 'second', offset: 12, affinity: 'after' }, focus: { sceneId: 'second', offset: 5, affinity: 'after' } }
  const f = projectionFixture(selection)
  f.controller.focusScene(f.refs[1])
  f.controller.project([f.refs[1]])
  assert.deepEqual(f.calls, [], 'a deferred IME projection must not reveal the old surface')
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.deepEqual(f.calls, ['focus', { reveal: selection.focus }, { selection }])
  assert.deepEqual(f.errors, [])
})

test('Focus scene starts at the target beginning when the caret belongs to another scene', () => {
  const f = projectionFixture({ anchor: { sceneId: 'first', offset: 12 }, focus: { sceneId: 'first', offset: 12 } })
  f.controller.focusScene(f.refs[1])
  f.controller.project([f.refs[1]])
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.deepEqual(f.calls[1], { reveal: { sceneId: 'second', offset: 0, affinity: 'after' } })
  assert.deepEqual(f.calls[2].selection.anchor, f.calls[2].selection.focus)
  f.calls.length = 0
  f.controller.focusScene(f.refs[1])
  assert.equal(f.calls.length, 3, 'an already narrowed projection still reveals immediately')
})

test('a changed workspace discards pending Focus scene navigation', () => {
  const f = projectionFixture(null)
  f.controller.focusScene(f.refs[1])
  f.controller.registry = { context: { workspaceEpoch: 2 } }
  f.controller.project([f.refs[1]])
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.deepEqual(f.calls, [])
})

test('a newer scope choice cancels a deferred Focus scene request', () => {
  const f = projectionFixture(null)
  f.controller.focusScene(f.refs[1])
  f.controller.project([f.refs[1]])
  f.controller.cancelSceneFocus()
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.deepEqual(f.calls, [])
})

test('scope narrowing retains the visible caret and waits for the exact new projection', () => {
  const selection = { anchor: { sceneId: 'second', offset: 12, affinity: 'after' }, focus: { sceneId: 'second', offset: 5, affinity: 'after' } }
  const f = projectionFixture(selection)
  assert.deepEqual(f.controller.retainScopePosition(), f.refs[1])
  f.controller.restoreScopePosition([f.refs[1]])
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.deepEqual(f.calls, [], 'an old projection acknowledgement must not consume the scope position')
  f.controller.project([f.refs[1]])
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.deepEqual(f.calls, ['focus', { reveal: selection.focus, viewportOffset: 225 }, { selection }])
})

test('scope expansion restores a range in a multi-scene projection at the same viewport offset', () => {
  const selection = { anchor: { sceneId: 'second', offset: 12, affinity: 'after' }, focus: { sceneId: 'second', offset: 5, affinity: 'after' } }
  const f = projectionFixture(selection)
  f.controller.project([f.refs[1]])
  f.controller.message({ type: 'writingProjectionApplied' })
  f.controller.retainScopePosition()
  f.controller.restoreScopePosition(f.refs)
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.deepEqual(f.calls, [])
  f.controller.project(f.refs)
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.deepEqual(f.calls, ['focus', { reveal: selection.focus, viewportOffset: 225 }, { selection }])
})

test('scope change uses the visible scene when the old caret is scrolled out of view', () => {
  const f = projectionFixture({ anchor: { sceneId: 'first', offset: 12, affinity: 'after' }, focus: { sceneId: 'first', offset: 12, affinity: 'after' } })
  f.roots.get('second').getBoundingClientRect = () => ({ top: -60, bottom: 900 })
  assert.deepEqual(f.controller.retainScopePosition(), f.refs[1])
  f.controller.restoreScopePosition([f.refs[1]])
  f.controller.project([f.refs[1]])
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.deepEqual(f.calls[1], { reveal: { sceneId: 'second', offset: 0, affinity: 'after' }, viewportOffset: -140 })
})

test('scope restoration retains its request until the projected scene root is attached', () => {
  const selection = { anchor: { sceneId: 'second', offset: 5, affinity: 'after' }, focus: { sceneId: 'second', offset: 5, affinity: 'after' } }
  const f = projectionFixture(selection)
  f.controller.retainScopePosition()
  f.controller.restoreScopePosition([f.refs[1]])
  f.controller.project([f.refs[1]])
  f.roots.get('second').isConnected = false
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.deepEqual(f.calls, [])
  f.roots.get('second').isConnected = true
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.equal(f.calls.length, 3)
})

test('scope restoration collapses a range only when its other endpoint leaves the projection', () => {
  const f = projectionFixture({ anchor: { sceneId: 'first', offset: 12, affinity: 'after' }, focus: { sceneId: 'second', offset: 5, affinity: 'after' } })
  f.controller.retainScopePosition()
  f.controller.restoreScopePosition([f.refs[1]])
  f.controller.project([f.refs[1]])
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.deepEqual(f.calls[2].selection.anchor, f.calls[2].selection.focus)
})

test('a queued old projection notification cannot restore while the DOM still contains the old run', () => {
  const selection = { anchor: { sceneId: 'second', offset: 5, affinity: 'after' }, focus: { sceneId: 'second', offset: 5, affinity: 'after' } }
  const f = projectionFixture(selection)
  f.controller.retainScopePosition()
  f.controller.restoreScopePosition([f.refs[1]])
  f.controller.project([f.refs[1]])
  f.domProjection(f.refs)
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.deepEqual(f.calls, [])
  f.domProjection([f.refs[1]])
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.equal(f.calls.length, 3)
})

test('newer explicit navigation supersedes a scope position awaiting projection', () => {
  const f = projectionFixture({ anchor: { sceneId: 'second', offset: 5, affinity: 'after' }, focus: { sceneId: 'second', offset: 5, affinity: 'after' } })
  f.controller.message({ type: 'writingProjectionApplied' })
  f.controller.retainScopePosition()
  const point = { sceneId: 'first', offset: 2, affinity: 'after' }
  assert.equal(f.controller.reveal(f.refs[0], { anchor: point, focus: point }), true)
  f.calls.length = 0
  f.controller.restoreScopePosition(f.refs)
  f.controller.project(f.refs)
  f.controller.message({ type: 'writingProjectionApplied' })
  assert.deepEqual(f.calls, [], 'a delayed scope request must not undo newer explicit navigation')
})
