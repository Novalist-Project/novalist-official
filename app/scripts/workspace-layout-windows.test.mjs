import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadRendererSource } from './renderer-source-loader.mjs'
import { loadPaneSources } from './pane-source-loader.mjs'

// Issue #75: a saved workspace layout brings back the windows that were
// undocked when it was saved. The fake bridge stands in for the main process:
// it opens windows, lists the open ones, and replaces them on restore.

const paneWindows = loadRendererSource('../shared/paneWindows.ts')

function zustand() {
  return {
    create: (init) => {
      let state
      const listeners = new Set()
      const set = (patch) => {
        const previous = state
        state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
        for (const listener of listeners) listener(state, previous)
      }
      const get = () => state
      state = init(set, get)
      const hook = (select) => select(state)
      Object.assign(hook, { getState: get, setState: set, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) } })
      return hook
    }
  }
}

function bridge({ isMobile = false, refuseClose = false } = {}) {
  const open = []
  const restored = []
  return {
    open, restored,
    novalist: {
      isMobile,
      openPaneWindow: async (request) => {
        open.push({ content: paneWindows.contentFromRequest(request), placement: { bounds: { x: 1940, y: 40, width: 720, height: 900 }, maximized: false, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } } })
      },
      listPaneWindows: async () => open.slice(),
      restorePaneWindows: async (windows) => {
        if (refuseClose && open.length) throw new Error('A window could not save its pending edits.')
        restored.push(windows)
        open.splice(0, open.length, ...windows)
      },
      toggleSceneNotes: async () => {}
    }
  }
}

function session(storage, host) {
  const localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  const window = { novalist: host.novalist }
  const { panes, migration } = loadPaneSources({ localStorage, window })
  const { create } = zustand()
  const first = panes.newLeaf('write')
  const useShellStore = create(() => ({
    mainView: 'write', mode: 'write', panes: first, activePaneId: first.id, extView: null,
    binderTab: 'chapters', binderVisible: true, binderWidth: 300, inspectorVisible: true, inspectorWidth: 320,
    inspectorTab: 'context', notesDockVisible: false, focusMode: false
  }))
  const toasts = []
  const shellStore = {
    BINDER_MIN: 290, BINDER_MAX: 640, INSPECTOR_MIN: 280, INSPECTOR_MAX: 720,
    savePanelSize: () => {}, setPaneViewIn: panes.setPaneViewIn, useShellStore,
    withSavedPanes: (_ids, proceed) => proceed()
  }
  const layouts = loadRendererSource('src/stores/layoutStore.ts', {
    zustand: { create }, '../shell/modes': loadRendererSource('src/shell/modes.ts'),
    './shellPanes': panes, './writingLayoutMigration': migration, './shellStore': shellStore,
    '../../../shared/paneWindows': paneWindows,
    './hostBridgeStore': { useHostBridgeStore: { getState: () => ({ pushToast: (text) => toasts.push(text) }) } },
    '../i18n': { default: { t: (key) => key } }
  }, { localStorage, window })
  return { layouts, useShellStore, toasts }
}

// Values built inside the loaded module come from another realm.
const plain = (value) => JSON.parse(JSON.stringify(value))
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }
const codex = { view: 'codex', projectPath: 'P', chapterGuid: null, sceneId: null, bookId: 'B', draftId: null, writingScope: 'manuscript', selectedSceneIds: null }

test('a saved workspace layout reopens the windows that were undocked when it was saved', async () => {
  const storage = new Map()
  const before = bridge()
  const first = session(storage, before)
  await before.novalist.openPaneWindow(codex)
  await first.layouts.useLayoutStore.getState().save('Two monitors')

  // Close and reopen: a new renderer session over the same stored preferences,
  // with no undocked window open.
  const after = bridge()
  const second = session(storage, after)
  second.layouts.useLayoutStore.getState().apply('Two monitors')
  await settle()

  assert.equal(after.restored.length, 1, `stored layout: ${storage.get('nl.shell.layouts')}`)
  assert.equal(after.restored[0].length, 1)
  assert.equal(after.restored[0][0].content.panes.view, 'codex')
  assert.deepEqual(plain(after.restored[0][0].placement.bounds), { x: 1940, y: 40, width: 720, height: 900 })
  assert.ok(!storage.get('nl.shell.layouts').includes('"P"'), 'a layout stores no project path')
})

test('a layout saved with no undocked windows closes the open ones when applied', async () => {
  const storage = new Map()
  const host = bridge()
  const s = session(storage, host)
  await s.layouts.useLayoutStore.getState().save('Single')
  await host.novalist.openPaneWindow(codex)
  s.layouts.useLayoutStore.getState().apply('Single')
  await settle()
  assert.deepEqual(host.restored, [[]])
  assert.equal(host.open.length, 0)
})

test('a layout saved before undocked windows were recorded applies without touching open windows', async () => {
  const storage = new Map([['nl.shell.layouts', JSON.stringify([{ name: 'Old', mainView: 'codex', binderTab: 'chapters', binderVisible: false,
    binderWidth: 300, inspectorVisible: true, inspectorWidth: 320, inspectorTab: 'context', notesDockVisible: false, focusMode: false }])]])
  const host = bridge()
  const s = session(storage, host)
  await host.novalist.openPaneWindow(codex)
  s.layouts.useLayoutStore.getState().apply('Old')
  await settle()
  assert.equal(host.restored.length, 0)
  assert.equal(host.open.length, 1)
  assert.equal(s.useShellStore.getState().mainView, 'codex')
  assert.equal(s.useShellStore.getState().binderVisible, false)
})

test('a refused close applies nothing: the windows stay open, the main window keeps its shape, and the writer is told', async () => {
  const storage = new Map()
  const host = bridge({ refuseClose: true })
  const s = session(storage, host)
  await s.layouts.useLayoutStore.getState().save('Single')
  await host.novalist.openPaneWindow(codex)
  s.useShellStore.setState({ binderVisible: false, mainView: 'codex', binderWidth: 500 })
  s.layouts.useLayoutStore.getState().apply('Single')
  await settle()
  assert.equal(host.restored.length, 0)
  assert.equal(host.open.length, 1)
  assert.deepEqual(s.toasts, ['layouts.windowsNotApplied'])
  const shell = s.useShellStore.getState()
  assert.deepEqual([shell.binderVisible, shell.mainView, shell.binderWidth], [false, 'codex', 500])
})

test('the main window takes the layout\'s shape once its windows are in place', async () => {
  const storage = new Map()
  const host = bridge()
  const s = session(storage, host)
  await s.layouts.useLayoutStore.getState().save('Single')
  s.useShellStore.setState({ binderVisible: false })
  let release
  host.novalist.restorePaneWindows = (windows) => new Promise((resolve) => { release = () => { host.restored.push(windows); resolve() } })
  s.layouts.useLayoutStore.getState().apply('Single')
  await settle()
  assert.equal(s.useShellStore.getState().binderVisible, false, 'nothing changes while the windows are being replaced')
  release()
  await settle()
  assert.equal(s.useShellStore.getState().binderVisible, true)
})

test('mobile records no windows and applies none', async () => {
  const storage = new Map()
  const host = bridge({ isMobile: true })
  const s = session(storage, host)
  await host.novalist.openPaneWindow(codex)
  await s.layouts.useLayoutStore.getState().save('Phone')
  assert.deepEqual(JSON.parse(storage.get('nl.shell.layouts'))[0].windows, [])
  s.layouts.useLayoutStore.getState().apply('Phone')
  await settle()
  assert.equal(host.restored.length, 0)
})

test('corrupt recorded windows are dropped rather than opened', async () => {
  const storage = new Map([['nl.shell.layouts', JSON.stringify([{ name: 'Bad', mainView: 'write', binderTab: 'chapters', binderVisible: true,
    binderWidth: 300, inspectorVisible: true, inspectorWidth: 320, inspectorTab: 'context', notesDockVisible: false, focusMode: false,
    windows: [{ content: { panes: { kind: 'leaf', id: 'a', view: '../../etc' } } }, 'x',
      { content: { panes: { kind: 'leaf', id: 'b', view: 'maps' }, activePane: 9, scenes: [{ pane: 4, chapterGuid: 'c', sceneId: 's' }] }, placement: { bounds: { x: 'a' } } }] }])]])
  const host = bridge()
  const s = session(storage, host)
  s.layouts.useLayoutStore.getState().apply('Bad')
  await settle()
  assert.equal(host.restored[0].length, 1)
  const [window] = host.restored[0]
  assert.equal(window.content.panes.view, 'maps')
  assert.equal(window.content.activePane, 0)
  assert.deepEqual(plain(window.content.scenes), [])
  assert.equal(window.placement, null)
})
