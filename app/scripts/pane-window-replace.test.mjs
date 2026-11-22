import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const source = buildSync({
  stdin: { contents: "export * from './src/main/pane-window-replace'; export * from './src/main/window-close'; export * from './src/main/window-close-request'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) },
  bundle: true, platform: 'node', format: 'esm', write: false
}).outputFiles[0].text
const { PaneWindowReplace, WindowCloseCoordinator, WindowCloseRequests } =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

const tick = () => new Promise((resolve) => setImmediate(resolve))
const layout = (view) => [{ content: { panes: { kind: 'leaf', id: 'p', view }, activePane: 0, scenes: [], selectedSceneIds: null, extView: null }, placement: null }]

/**
 * The real close coordinator and close requests over fake windows. Each window
 * answers every close stage itself; `hold(id)` makes its save wait until
 * released, `refuse(id)` makes its save fail.
 */
function desktop() {
  const coordinator = new WindowCloseCoordinator(1000, () => {})
  const windows = []
  const held = new Map()
  const refused = new Set()
  let frozen = false
  let quit = false
  const opened = []
  const add = (id, main = false) => {
    const listeners = []
    const window = {
      id, main, webContents: { id }, destroyed: false,
      isDestroyed() { return this.destroyed },
      once(event, listener) { if (event === 'closed') listeners.push(listener) },
      close() { if (this.destroyed) return; this.destroyed = true; coordinator.remove(id); for (const listener of listeners) listener() }
    }
    coordinator.register(id, {
      focus() {},
      send(token, stage) {
        const answer = () => coordinator.acknowledge(id, token, !(stage === 'flush' && refused.has(id)))
        if (stage === 'flush' && held.has(id)) held.get(id).push(answer)
        else queueMicrotask(answer)
      }
    })
    windows.push(window)
    return window
  }
  const main = add(1, true)
  const requests = new WindowCloseRequests(coordinator, {
    getMainWindow: () => (main.destroyed ? null : main),
    getWindows: () => windows.filter((window) => !window.destroyed),
    approvedCloses: new Set(),
    quit: () => { quit = true },
    closingAll: () => { frozen = true }
  })
  let next = 10
  const replace = new PaneWindowReplace({
    open: () => windows.filter((window) => !window.main && !window.destroyed),
    close: (targets) => requests.requestOwn(targets),
    closingAll: () => frozen,
    openSaved: (saved) => { for (const entry of saved) { opened.push(entry.content.panes.view); add(next++) } }
  })
  return {
    main, requests, replace, opened, add,
    open: () => windows.filter((window) => !window.main && !window.destroyed),
    alive: () => !main.destroyed,
    hold: (id) => held.set(id, []),
    release: (id) => { for (const answer of held.get(id) ?? []) answer(); held.delete(id) },
    refuse: (id) => refused.add(id),
    get quit() { return quit }
  }
}

test('a refusal leaves every undocked window open and opens nothing', async () => {
  const d = desktop()
  const [a, b] = [d.add(2), d.add(3)]
  d.refuse(3)
  await assert.rejects(d.replace.replace(layout('codex'), d.alive), /could not save/)
  assert.equal(a.destroyed, false)
  assert.equal(b.destroyed, false)
  assert.deepEqual(d.opened, [])
})

test('the open windows close and the layout opens in their place', async () => {
  const d = desktop()
  const old = d.add(2)
  await d.replace.replace(layout('codex'), d.alive)
  assert.equal(old.destroyed, true)
  assert.deepEqual(d.opened, ['codex'])
  assert.equal(d.open().length, 1)
})

test('a second replace during the first does not open windows twice', async () => {
  const d = desktop()
  d.add(2)
  d.hold(2)
  const first = d.replace.replace(layout('codex'), d.alive)
  const second = d.replace.replace(layout('maps'), d.alive)
  await tick()
  d.release(2)
  await first
  await second
  // The second replaced what the first opened: one window, the last layout's.
  assert.deepEqual(d.opened, ['codex', 'maps'])
  assert.equal(d.open().length, 1)
})

test('a replace during an unrelated single close waits for it and then closes and opens correctly', async () => {
  const d = desktop()
  const byHand = d.add(2)
  const other = d.add(3)
  d.hold(2)
  const closing = d.requests.request(byHand, false)
  await tick()
  const replaced = d.replace.replace(layout('codex'), d.alive)
  await tick()
  d.release(2)
  await closing
  await replaced
  assert.equal(byHand.destroyed, true)
  assert.equal(other.destroyed, true)
  assert.deepEqual(d.opened, ['codex'])
})

test('nothing opens once a quit has started while the replace was saving', async () => {
  const d = desktop()
  d.add(2)
  d.hold(2)
  const replaced = d.replace.replace(layout('codex'), d.alive)
  await tick()
  const quitting = d.requests.request(d.main, true)
  await tick()
  d.release(2)
  await tick()
  d.release(2)
  await Promise.allSettled([replaced, quitting])
  await assert.rejects(replaced)
  assert.equal(d.quit, true)
  assert.deepEqual(d.opened, [])
})

test('nothing opens once the main window is gone', async () => {
  const d = desktop()
  d.add(2)
  d.hold(2)
  const replaced = d.replace.replace(layout('codex'), d.alive)
  await tick()
  d.main.destroyed = true
  d.release(2)
  await assert.rejects(replaced, /closing/)
  assert.deepEqual(d.opened, [])
})
