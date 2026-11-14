import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { create } from 'zustand'
import { loadRendererSource } from './renderer-source-loader.mjs'

const modes = { MODE_VIEWS: { write: ['write', 'manuscript'], plan: ['timeline'], world: ['codex'] } }
const migration = () => loadRendererSource('src/stores/writingLayoutMigration.ts', { '../shell/modes': modes })

function shellFixture(isMobile = false) {
  const globals = { localStorage: { getItem: () => null }, window: { novalist: { isMobile } },
    document: { activeElement: null }, HTMLElement: class {} }
  const paneTools = loadRendererSource('src/stores/shellPanes.ts', { './writingLayoutMigration': migration() }, globals)
  return loadRendererSource('src/stores/shellStore.ts', {
    zustand: { create }, './shellPanes': paneTools, './writingLayoutMigration': migration(),
    '../views/settings/settingsNavigation': {}, '../views/settings/settingsRegistry': {},
    '../shell/modes': { ...modes, modeOf: view => view === 'codex' ? 'world' : 'write' },
    './shellPanels': { storedPanels: {}, initialPanelSize: () => 200, shellCapacityForWidth: () => 'wide', screenW: 1200 }
  }, globals, readFileSync(new URL('../src/renderer/src/stores/shellStore.ts', import.meta.url), 'utf8')
    .replace(/^export \{[^}]+\} from '[^']+'$/gm, '')).useShellStore
}

test('legacy navigation selects manuscript scope while ordinary Write preserves pane scope', () => {
  const shell = shellFixture()
  const pane = shell.getState().activePaneId
  shell.getState().setPaneWritingScope(pane, 'scene')
  shell.getState().setMainView('codex')
  shell.getState().setMainView('write')
  assert.equal(shell.getState().panes.writingScope, 'scene')
  shell.getState().setMainView('manuscript')
  assert.equal(shell.getState().mainView, 'write')
  assert.equal(shell.getState().panes.writingScope, 'manuscript')
  shell.getState().setPaneWritingScope(pane, 'chapter')
  shell.getState().setPaneView(pane, 'manuscript')
  assert.equal(shell.getState().panes.writingScope, 'manuscript')
  const mobile = shellFixture(true)
  mobile.getState().setMainView('manuscript')
  assert.equal(mobile.getState().mainView, 'manuscript')
})

test('legacy recursive layouts migrate idempotently without changing unrelated views', () => {
  const { normalizeWritingLayout } = migration()
  const input = { kind: 'split', id: 'root', direction: 'column', sizes: [25, 75], children: [
    { kind: 'leaf', id: 'writer', view: 'manuscript' },
    { kind: 'split', id: 'nested', direction: 'row', sizes: [40, 60], children: [
      { kind: 'leaf', id: 'focus', view: 'write', writingScope: 'scene' },
      { kind: 'leaf', id: 'world', view: 'codex' }
    ] }
  ] }
  const migrated = normalizeWritingLayout(input)
  assert.equal(migrated.children[0].view, 'write')
  assert.equal(migrated.children[0].writingScope, 'manuscript')
  assert.equal(migrated.children[1].children[0].writingScope, 'scene')
  assert.equal(migrated.children[1].children[1].view, 'codex')
  assert.deepEqual(migrated.sizes, [25, 75])
  assert.deepEqual(normalizeWritingLayout(migrated), migrated)
  assert.equal(input.children[0].view, 'manuscript')
})

test('invalid layouts get usable leaves, unique IDs and valid proportions', () => {
  const { normalizeWritingLayout } = migration()
  const migrated = normalizeWritingLayout({ kind: 'split', sizes: [NaN, -1], children: [
    { kind: 'leaf', id: 'same', view: 'unknown', writingScope: 'invalid', html: 'prose' },
    { kind: 'leaf', id: 'same', view: 'write', writingScope: 'chapter' }
  ] })
  assert.equal(migrated.children[0].view, 'write')
  assert.equal(migrated.children[0].writingScope, 'manuscript')
  assert.equal(migrated.children[0].html, undefined)
  assert.notEqual(migrated.children[0].id, migrated.children[1].id)
  assert.deepEqual(migrated.sizes, [50, 50])
  assert.equal(normalizeWritingLayout(null).view, 'write')
})

test('extreme and rounded split proportions stay finite and idempotent', () => {
  const { normalizeWritingLayout } = migration()
  for (const sizes of [[Number.MAX_VALUE, Number.MAX_VALUE], [1, 2, 3], [Number.MIN_VALUE, Number.MAX_VALUE]]) {
    const normalized = normalizeWritingLayout({ kind: 'split', id: 'root', sizes,
      children: sizes.map((_, index) => ({ kind: 'leaf', id: `p${index}`, view: 'write' })) })
    assert.ok(normalized.sizes.every(size => Number.isFinite(size) && size > 0))
    assert.ok(Math.abs(normalized.sizes.reduce((sum, size) => sum + size, 0) - 100) < 1e-9)
    assert.deepEqual(normalizeWritingLayout(normalized), normalized)
  }
})

test('stored pane layouts migrate on desktop but retain the mobile adapter', () => {
  const root = { kind: 'leaf', id: 'old', view: 'manuscript' }
  for (const isMobile of [false, true]) {
    const tools = loadRendererSource('src/stores/shellPanes.ts', { './writingLayoutMigration': migration() }, {
      localStorage: { getItem: () => JSON.stringify([{ name: 'Old', root }]) }, window: { novalist: { isMobile } }
    })
    assert.equal(tools.storedLayouts[0].root.view, isMobile ? 'manuscript' : 'write')
  }
})

test('detached payload retains scope and explicit empty selection and rejects foreign values', () => {
  const { normalizeDetachedPaneRequest } = loadRendererSource('../shared/detachedPane.ts')
  const request = normalizeDetachedPaneRequest({ view: 'write', writingScope: 'chapter', projectPath: 'project',
    bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene', selectedSceneIds: [] })
  assert.equal(request.writingScope, 'chapter')
  assert.deepEqual(structuredClone(request.selectedSceneIds), [])
  assert.equal(request.bookId, 'book')
  const malformed = normalizeDetachedPaneRequest({ view: {}, writingScope: 'invalid', selectedSceneIds: [9], projectPath: 7 })
  assert.equal(malformed.view, 'write')
  assert.equal(malformed.writingScope, 'manuscript')
  assert.equal(malformed.selectedSceneIds, null)
  assert.equal(malformed.projectPath, null)
})

test('mobile legacy manuscript stays available and scope changes alter layout identity', () => {
  const { normalizeWritingLayout } = migration()
  assert.equal(normalizeWritingLayout({ kind: 'leaf', id: 'a', view: 'manuscript' }, false).view, 'manuscript')
  const { sameArrangement, newLeaf, splitPane, setPaneWritingScopeIn } = loadRendererSource('src/stores/shellPanes.ts', {
    './writingLayoutMigration': migration()
  }, { localStorage: { getItem: () => null } })
  const pane = newLeaf('write')
  assert.equal(pane.writingScope, 'manuscript')
  const focused = setPaneWritingScopeIn(pane, pane.id, 'scene')
  assert.equal(sameArrangement(pane, focused), false)
  const split = splitPane(focused, pane.id, 'row')
  assert.equal(split.root.children[0].writingScope, 'scene')
  assert.equal(split.root.children[1].writingScope, 'manuscript')
})

test('named workspaces restore independent scopes and pane geometry after restart', () => {
  const storage = new Map()
  const globals = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    window: { novalist: {} } }
  const paneTools = loadRendererSource('src/stores/shellPanes.ts', { './writingLayoutMigration': migration() }, globals)
  const original = { kind: 'split', id: 'root', direction: 'row', sizes: [35, 65], children: [
    { kind: 'leaf', id: 'first', view: 'write', writingScope: 'scene' },
    { kind: 'leaf', id: 'second', view: 'write', writingScope: 'manuscript' }
  ] }
  const shell = create(() => ({ panes: original, activePaneId: 'second', mainView: 'write', mode: 'write',
    binderTab: 'chapters', binderVisible: true, binderWidth: 220, inspectorVisible: false, inspectorWidth: 260,
    inspectorTab: 'scene', notesDockVisible: false, focusMode: false }))
  const dependencies = { zustand: { create }, '../shell/modes': { modeOf: () => 'write' },
    './shellPanes': paneTools, './writingLayoutMigration': migration(),
    './shellStore': { useShellStore: shell, BINDER_MIN: 180, BINDER_MAX: 480, INSPECTOR_MIN: 200, INSPECTOR_MAX: 480,
      savePanelSize() {}, withSavedPanes: (_ids, proceed) => proceed(), setPaneViewIn: paneTools.setPaneViewIn } }
  const first = loadRendererSource('src/stores/layoutStore.ts', dependencies, globals)
  first.useLayoutStore.getState().save('Two scopes')
  shell.setState({ panes: { kind: 'leaf', id: 'only', view: 'codex' }, activePaneId: 'only', mainView: 'codex' })
  const reopened = loadRendererSource('src/stores/layoutStore.ts', dependencies, globals)
  reopened.useLayoutStore.getState().apply('Two scopes')
  const restored = shell.getState()
  assert.deepEqual(structuredClone(paneTools.paneLeaves(restored.panes).map(pane => pane.writingScope)), ['scene', 'manuscript'])
  assert.deepEqual(structuredClone(restored.panes.sizes), [35, 65])
  assert.equal(restored.activePaneId, restored.panes.children[1].id)
  assert.equal(restored.binderWidth, 220)
  assert.equal(restored.inspectorVisible, false)
  storage.set('nl.shell.layouts', JSON.stringify([{ name: 'Incomplete', mainView: 'manuscript',
    binderWidth: null, inspectorWidth: 'invalid' }]))
  const incomplete = loadRendererSource('src/stores/layoutStore.ts', dependencies, globals)
  incomplete.useLayoutStore.getState().apply('Incomplete')
  assert.equal(shell.getState().mainView, 'write')
  assert.equal(shell.getState().binderWidth, 220)
  assert.equal(shell.getState().inspectorWidth, 260)
  assert.equal(shell.getState().binderVisible, true)
})
