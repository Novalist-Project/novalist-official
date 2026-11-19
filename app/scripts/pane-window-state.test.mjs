import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadRendererSource } from './renderer-source-loader.mjs'
import { loadPaneSources } from './pane-source-loader.mjs'

// Values built inside the loaded module come from another realm.
const plain = (value) => JSON.parse(JSON.stringify(value))

function store(state) {
  let current = state
  return { getState: () => current, setState: (patch) => { current = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) } } }
}

function harness({ switchDuring = false, panes: startPanes, extensions = [] } = {}) {
  const { panes, migration, environment } = loadPaneSources()
  const first = panes.newLeaf('write')
  const shell = store({ panes: startPanes?.(panes) ?? first, activePaneId: first.id, extView: null, mainView: 'dashboard' })
  shell.setState({
    setActivePane: (id) => {
      const leaf = panes.findPane(shell.getState().panes, id)
      if (leaf?.kind === 'leaf' && leaf.view !== 'sceneNotes') shell.setState({ activePaneId: id, mainView: leaf.view })
    }
  })
  const manuscript = store({ composed: 'untouched' })
  const opened = []
  const project = store({
    workspaceEpoch: 1, projectPath: 'A',
    chapters: [{ guid: 'c', scenes: [{ id: 's1' }, { id: 's2' }] }],
    openSceneIn: async (paneId, chapterGuid, sceneId) => {
      opened.push(sceneId)
      // The real action makes the scene's pane the active one.
      shell.getState().setActivePane(paneId)
      // Another window switched the shared workspace while this scene opened.
      if (switchDuring) project.setState({ workspaceEpoch: 2, projectPath: 'B' })
    }
  })
  const state = loadRendererSource('src/shell/paneWindowState.ts', {
    react: { useEffect() {}, useState: (value) => [value, () => {}] },
    '../stores/shellPanes': panes, '../stores/writingLayoutMigration': migration,
    '../stores/shellStore': { useShellStore: shell },
    '../stores/projectStore': { useProjectStore: project, editorPane: () => ({}) },
    '../stores/manuscriptStore': { useManuscriptStore: manuscript },
    '../stores/extensionsStore': { useExtensionsStore: store({ views: extensions }) }
  }, environment)
  return { state, panes, shell, opened, manuscript }
}

// A split recorded with the editor (scene s1) on the left and the Codex on the
// right, the Codex active.
const recorded = {
  panes: { kind: 'split', id: 'r', direction: 'row', sizes: [62, 38], children: [
    { kind: 'leaf', id: 'a', view: 'write', writingScope: 'scene' }, { kind: 'leaf', id: 'b', view: 'codex' }] },
  activePane: 1, extView: null, selectedSceneIds: ['s1', 'gone'],
  scenes: [{ pane: 0, chapterGuid: 'c', sceneId: 's1' }]
}

test('a restored window opens its scenes and the part of its selected run the project still has', async () => {
  const h = harness()
  const tree = { kind: 'split', id: 'root', direction: 'row', sizes: [50, 50], children: [h.panes.newLeaf('write'), h.panes.newLeaf('write')] }
  h.shell.setState({ panes: tree, activePaneId: tree.children[0].id })
  await h.state.openRestoredScenes({ ...recorded, panes: tree, scenes: [{ pane: 0, chapterGuid: 'c', sceneId: 's1' }, { pane: 1, chapterGuid: 'c', sceneId: 's2' }] }, tree)
  assert.deepEqual(h.opened, ['s1', 's2'])
  assert.deepEqual(plain(h.manuscript.getState().composed), ['s1'])
  assert.equal(h.shell.getState().activePaneId, tree.children[0].id, 'opening scenes does not move the active pane')
})

test('a workspace switch while a restored window opens its scenes stops it there', async () => {
  const h = harness({ switchDuring: true })
  const tree = { kind: 'split', id: 'root', direction: 'row', sizes: [50, 50], children: [h.panes.newLeaf('write'), h.panes.newLeaf('write')] }
  h.shell.setState({ panes: tree })
  await h.state.openRestoredScenes({ ...recorded, panes: tree, scenes: [{ pane: 0, chapterGuid: 'c', sceneId: 's1' }, { pane: 1, chapterGuid: 'c', sceneId: 's2' }] }, tree)
  assert.deepEqual(h.opened, ['s1'], 'no further recorded scene opens in the new project')
  assert.equal(h.manuscript.getState().composed, 'untouched', 'the selected run is not applied to the new project')
})

test('the main window gets back its split: sizes, views, scopes, scene and active pane', async () => {
  const h = harness()
  await h.state.restoreMainPanes(recorded)
  const { panes, activePaneId, mainView } = h.shell.getState()
  assert.equal(panes.kind, 'split')
  assert.equal(panes.direction, 'row')
  assert.deepEqual(plain(panes.sizes), [62, 38])
  assert.deepEqual(plain(h.panes.paneLeaves(panes).map((leaf) => [leaf.view, leaf.writingScope ?? null])), [['write', 'scene'], ['codex', null]])
  assert.equal(activePaneId, panes.children[1].id)
  assert.equal(mainView, 'codex')
  assert.deepEqual(h.opened, ['s1'])
})

test('a deleted scene and a removed extension view do not stop the rest of the split coming back', async () => {
  const h = harness({ extensions: [] })
  await h.state.restoreMainPanes({ ...recorded, extView: { extensionId: 'gone', key: 'panel' }, scenes: [{ pane: 0, chapterGuid: 'c', sceneId: 'deleted' }] })
  assert.equal(h.panes.paneLeaves(h.shell.getState().panes).length, 2)
  assert.deepEqual(h.opened, [])
  assert.equal(h.shell.getState().extView, null)
  const kept = harness({ extensions: [{ extensionId: 'ext', key: 'panel' }] })
  await kept.state.restoreMainPanes({ ...recorded, extView: { extensionId: 'ext', key: 'panel' } })
  assert.deepEqual(plain(kept.shell.getState().extView), { extensionId: 'ext', key: 'panel' })
})

test('docked notes stay docked through a restore, on the same edge, at the same share, as the same pane', async () => {
  let notesId
  const h = harness({ panes: (panes) => {
    const editor = panes.newLeaf('write')
    const docked = panes.dockNotesPane(editor, editor.id, 'bottom')
    docked.sizes = [75, 25]
    notesId = panes.paneLeaves(docked).find((leaf) => leaf.view === 'sceneNotes').id
    return docked
  } })
  await h.state.restoreMainPanes(recorded)
  const { panes, activePaneId } = h.shell.getState()
  const leaves = h.panes.paneLeaves(panes)
  assert.deepEqual(plain(leaves.map((leaf) => leaf.view)), ['write', 'codex', 'sceneNotes'])
  assert.equal(leaves[2].id, notesId)
  const holder = (function find(node) {
    if (node.kind === 'leaf') return null
    return node.children.some((child) => child.id === notesId) ? node : node.children.map(find).find(Boolean) ?? null
  })(panes)
  assert.equal(holder.direction, 'column')
  assert.deepEqual(plain(holder.sizes), [75, 25])
  assert.equal(holder.children[0].id, activePaneId, 'the notes sit under the active pane')
})

test('only two or more panes besides docked notes count as a split', () => {
  const h = harness()
  const editor = h.panes.newLeaf('write')
  assert.equal(h.state.isSplit(editor), false)
  assert.equal(h.state.isSplit(h.panes.dockNotesPane(editor, editor.id, 'right')), false)
  assert.equal(h.state.isSplit(h.panes.splitPane(editor, editor.id, 'row').root), true)
})
