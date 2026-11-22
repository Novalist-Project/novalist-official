import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = buildSync({
  stdin: { contents: "export * from './src/main/pane-window-sessions'; export * from './src/shared/paneWindows'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, platform: 'node', format: 'esm', write: false
}).outputFiles[0].text
const { PaneWindowSessions, fileSessionStorage, projectSessionKey, contentFromRequest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const windowOf = (view) => ({ content: contentFromRequest({ view, projectPath: null, chapterGuid: null, sceneId: null }),
  placement: { bounds: { x: 10, y: 20, width: 700, height: 800 }, maximized: false, workArea: null } })

function storage(text = null) {
  return { text, writes: 0, read() { return this.text }, write(value) { this.text = value; this.writes += 1 } }
}

test('project keys are path hashes that ignore case and trailing separators where the file system does', () => {
  const key = projectSessionKey('C:\\Books\\Novel\\', 'win32')
  assert.match(key, /^[0-9a-f]{64}$/)
  assert.equal(projectSessionKey('c:\\books\\novel', 'win32'), key)
  assert.notEqual(projectSessionKey('/books/Novel', 'linux'), projectSessionKey('/books/novel', 'linux'))
})

test('a project gets back the windows it had and the file names no path or view text beyond view names', () => {
  const store = storage()
  const sessions = new PaneWindowSessions(store, () => 5)
  const a = projectSessionKey('/books/a', 'linux')
  assert.deepEqual(sessions.enter(a), [])
  sessions.record([windowOf('codex'), windowOf('maps')])
  assert.ok(!store.text.includes('/books'))
  const reopened = new PaneWindowSessions(storage(store.text))
  assert.deepEqual(reopened.enter(a).map((entry) => entry.content.panes.view), ['codex', 'maps'])
  assert.deepEqual(reopened.enter(projectSessionKey('/books/b', 'linux')), [])
})

test('closing every window by hand forgets the set', () => {
  const store = storage()
  const sessions = new PaneWindowSessions(store)
  const a = projectSessionKey('/books/a', 'linux')
  sessions.enter(a)
  sessions.record([windowOf('codex')])
  sessions.record([])
  assert.deepEqual(new PaneWindowSessions(storage(store.text)).enter(a), [])
})

test('a frozen set ignores the closes that follow a quit until a project is entered or a window opens', () => {
  const store = storage()
  const sessions = new PaneWindowSessions(store)
  const a = projectSessionKey('/books/a', 'linux')
  sessions.enter(a)
  sessions.record([windowOf('codex'), windowOf('maps')])
  sessions.freeze()
  sessions.record([windowOf('maps')])
  sessions.record([])
  assert.equal(sessions.isFrozen, true)
  assert.equal(new PaneWindowSessions(storage(store.text)).enter(a).length, 2)
  sessions.thaw()
  sessions.record([windowOf('maps')])
  assert.equal(new PaneWindowSessions(storage(store.text)).enter(a).length, 1)
})

test('nothing is recorded before a project is entered, and old projects fall off past the limit', () => {
  const store = storage()
  let now = 0
  const sessions = new PaneWindowSessions(store, () => ++now, 2)
  sessions.record([windowOf('codex')])
  assert.equal(store.writes, 0)
  for (const name of ['a', 'b', 'c']) { sessions.enter(projectSessionKey(`/books/${name}`, 'linux')); sessions.record([windowOf('codex')]) }
  const reread = new PaneWindowSessions(storage(store.text))
  assert.equal(reread.enter(projectSessionKey('/books/a', 'linux')).length, 0)
  assert.equal(reread.enter(projectSessionKey('/books/c', 'linux')).length, 1)
})

test('windows that follow the workspace into another project leave the project they came from', () => {
  const store = storage()
  const sessions = new PaneWindowSessions(store)
  const a = projectSessionKey('/books/a', 'linux')
  const b = projectSessionKey('/books/b', 'linux')
  sessions.enter(a)
  sessions.record([windowOf('codex')])
  // Project B opened with the windows still open: they now belong to B.
  sessions.enter(b, true)
  sessions.record([windowOf('codex')])
  // Closed by hand in B.
  sessions.record([])
  const reread = new PaneWindowSessions(storage(store.text))
  assert.deepEqual(reread.enter(a), [])
  assert.deepEqual(reread.enter(b), [])
})

test('entering a project with no windows open keeps the previous project\'s set', () => {
  const store = storage()
  const sessions = new PaneWindowSessions(store)
  const a = projectSessionKey('/books/a', 'linux')
  sessions.enter(a)
  sessions.record([windowOf('codex')])
  sessions.enter(projectSessionKey('/books/b', 'linux'), false)
  assert.equal(new PaneWindowSessions(storage(store.text)).enter(a).length, 1)
})

test('the file is replaced whole: a write that cannot finish leaves the previous file intact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nl-pane-sessions-'))
  try {
    const path = join(directory, 'pane-windows.json')
    const file = fileSessionStorage(path)
    file.write('{"version":1,"projects":[]}')
    assert.equal(file.read(), '{"version":1,"projects":[]}')
    assert.equal(existsSync(`${path}.tmp`), false)
    // The temporary file cannot be written: the original must survive.
    mkdirSync(`${path}.tmp`)
    assert.throws(() => file.write('{"trunc'))
    assert.equal(readFileSync(path, 'utf8'), '{"version":1,"projects":[]}')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('a truncated file reads as empty instead of failing, and the next record writes a whole one', () => {
  const store = storage('{"version":1,"projects":[{"key":"' + 'a'.repeat(64) + '","at":1,"windows":[{"con')
  const sessions = new PaneWindowSessions(store)
  assert.deepEqual(sessions.enter('a'.repeat(64)), [])
  sessions.record([windowOf('maps')])
  assert.equal(JSON.parse(store.text).projects.length, 1)
})

const split = { panes: { kind: 'split', id: 'r', direction: 'row', sizes: [60, 40], children: [{ kind: 'leaf', id: 'a', view: 'write' }, { kind: 'leaf', id: 'b', view: 'codex' }] },
  activePane: 1, scenes: [{ pane: 0, chapterGuid: 'c1', sceneId: 's1' }], selectedSceneIds: null, extView: null }

test('the main window\'s split is remembered per project, beside its windows, and survives a reread', () => {
  const store = storage()
  const sessions = new PaneWindowSessions(store)
  const a = projectSessionKey('/books/a', 'linux')
  const b = projectSessionKey('/books/b', 'linux')
  sessions.recordMain(a, split)
  sessions.enter(a)
  sessions.record([windowOf('maps')])
  const reread = new PaneWindowSessions(storage(store.text))
  assert.equal(reread.mainFor(a).panes.children[1].view, 'codex')
  assert.equal(reread.mainFor(a).activePane, 1)
  assert.equal(reread.enter(a).length, 1)
  assert.equal(reread.mainFor(b), null)
  assert.ok(!store.text.includes('/books'))
})

test('unsplitting forgets the main split, and an entry with nothing left is dropped', () => {
  const store = storage()
  const sessions = new PaneWindowSessions(store)
  const a = projectSessionKey('/books/a', 'linux')
  sessions.recordMain(a, split)
  sessions.recordMain(a, null)
  assert.equal(new PaneWindowSessions(storage(store.text)).mainFor(a), null)
  assert.deepEqual(JSON.parse(store.text).projects, [])
})

test('windows leaving a project keep that project\'s main split, and freezing does not touch it', () => {
  const store = storage()
  const sessions = new PaneWindowSessions(store)
  const a = projectSessionKey('/books/a', 'linux')
  sessions.enter(a)
  sessions.record([windowOf('codex')])
  sessions.recordMain(a, split)
  sessions.enter(projectSessionKey('/books/b', 'linux'), true)
  sessions.freeze()
  sessions.recordMain(a, { ...split, activePane: 0 })
  const reread = new PaneWindowSessions(storage(store.text))
  assert.deepEqual(reread.enter(a), [])
  assert.equal(reread.mainFor(a).activePane, 0)
})

test('a corrupt or foreign file is treated as empty and a failed write does not throw', () => {
  for (const text of ['{', 'null', '[]', JSON.stringify({ projects: [{ key: '../x', windows: [windowOf('codex')] }, { key: 'a'.repeat(64), windows: 'no' }] })]) {
    assert.deepEqual(new PaneWindowSessions(storage(text)).enter('a'.repeat(64)), [])
  }
  const sessions = new PaneWindowSessions({ read: () => null, write: () => { throw new Error('disk full') } })
  sessions.enter('b'.repeat(64))
  assert.doesNotThrow(() => sessions.record([windowOf('codex')]))
})
