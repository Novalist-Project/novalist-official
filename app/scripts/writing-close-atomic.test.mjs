import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { loadRendererSource } from './renderer-source-loader.mjs'

const require = createRequire(import.meta.url)
const Y = require('yjs')
const result = await build({ stdin: { contents: "export * from './src/main/window-close'; export * from './src/main/window-close-request'; export * from './src/renderer/src/stores/writingDocuments'; export * from './src/renderer/src/stores/writingHistory'; export * from './src/renderer/src/collaboration/SharedSceneSession'; export * from './src/renderer/src/collaboration/sharedWritingAnnotations'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'text' } })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports)
const { WindowCloseCoordinator, WindowCloseRequests, getWritingDocumentRegistry, getWritingHistory, acceptWritingTransaction,
  SharedSceneSession, SharedWritingAnnotations } = module.exports

async function windowOwner(document, id) {
  const context = { workspaceId: `window-${id}-${crypto.randomUUID()}`, workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
  const ref = { bookId: 'book', draftId: 'draft', chapterGuid: 'chapter', sceneId: 'scene' }
  const options = { context, isCurrent: () => true, transport: {
    read: async () => ({ html: 'Original', hash: 'original' }), activate: async () => { throw new Error('No focused activation during close') },
    commit: async request => ({ status: 'committed', operationId: request.transactionId,
      hashes: request.changes.map(change => ({ ref: change.ref, hash: 'saved' })) })
  } }
  const registry = getWritingDocumentRegistry(options)
  await registry.read(ref)
  acceptWritingTransaction(registry, { id: crypto.randomUUID(), context, origin: 'writer', kind: 'input',
    changes: [{ ref, expectedRevision: 0, beforeHtml: 'Original', afterHtml: 'Local edit' }],
    annotationChanges: [], beforeSelection: null, afterSelection: null })
  const history = getWritingHistory(registry)
  const server = new Y.Doc()
  server.getText('prose').insert(0, 'Shared')
  server.getText('prose').insert(6, '\n', { block: JSON.stringify([{ id: 'paragraph', tag: 'p', attributes: {} }]) })
  const environment = { document, sanitizeSceneFragment(html) {
    const template = document.createElement('template'); template.innerHTML = html; return template.content
  }, toDisplayImages() {} }
  const shared = new SharedSceneSession(environment, Y.encodeStateAsUpdate(server), {
    read: async () => Y.encodeStateAsUpdate(server), write: async update => { Y.applyUpdate(server, update) }, subscribe: () => () => {}
  })
  shared.transact(prose => prose.insert(6, ' local'))
  const annotations = new SharedWritingAnnotations(async () => { throw new Error('No metadata writes in this fixture') })
  const lifecycle = loadRendererSource('src/stores/writingWorkspaceLifecycle.ts', {
    './writingDocuments': module.exports, './writingHistory': module.exports,
    '../collaboration/sharedWritingSessions': { prepareSharedWritingSessionsClose: () => shared.prepareClose() },
    '../collaboration/sharedWritingAnnotations': { prepareSharedWritingAnnotationsClose: () => annotations.prepareClose() }
  })
  return { registry, history, shared, options, ref, server,
    prepare: () => lifecycle.prepareWritingWorkspaceClose(context) }
}

function closeHost(owners) {
  const coordinator = new WindowCloseCoordinator(80)
  const disposals = new Map(), events = []
  let stageHook = async () => true
  const windows = owners.map((owner, index) => {
    const listeners = []
    const window = { id: index + 1, webContents: { id: index + 1 }, destroyed: false,
      isDestroyed() { return this.destroyed }, once(_event, listener) { listeners.push(listener) },
      close() { this.destroyed = true; events.push([index + 1, 'closed']); coordinator.remove(index + 1); listeners.forEach(listener => listener()) } }
    coordinator.register(index + 1, { send(token, stage) {
      events.push([index + 1, stage])
      void (async () => {
        if (!await stageHook(index + 1, stage)) { coordinator.acknowledge(index + 1, token, false); return }
        if (stage === 'flush') { await owner.registry.flush(); await owner.shared.flush() }
        if (stage === 'release') disposals.set(index, await owner.prepare())
        if (stage === 'commit') disposals.get(index)()
        if (stage === 'abort') disposals.delete(index)
        coordinator.acknowledge(index + 1, token, true)
      })().catch(() => coordinator.acknowledge(index + 1, token, false))
    }, focus() {} })
    return window
  })
  return { coordinator, windows, events, setStageHook: hook => { stageHook = hook } }
}

async function assertRetainedUndo(owner) {
  assert.equal(getWritingDocumentRegistry(owner.options), owner.registry)
  assert.equal(getWritingHistory(owner.registry), owner.history)
  assert.equal(owner.registry.isClosed, false)
  assert.equal(owner.shared.isClosed, false)
  assert.equal((await owner.history.undo()).status, 'applied')
  assert.equal(owner.registry.getSnapshot(owner.ref).html, 'Original')
  owner.shared.undo()
  assert.equal(owner.shared.prose.toString(), 'Shared\n')
}

test('the real update handler retains undo after refused launch and commits only after a successful retry', async () => {
  const dom = new JSDOM('')
  const owners = await Promise.all([1, 2].map(id => windowOwner(dom.window.document, id)))
  const host = closeHost(owners), handlers = new Map(), approved = new Set()
  let quit = false, retainedAtLaunch = false, refuse = true
  const { registerUpdateHandlers } = loadRendererSource('../main/update-handlers.ts', {
    electron: { app: { quit: () => { quit = true } }, BrowserWindow: {
      getAllWindows: () => host.windows, fromWebContents: sender => host.windows.find(window => window.webContents === sender)
    }, ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
    'node:crypto': { randomUUID: () => crypto.randomUUID() }, '../shared/selfUpdatePolicy': { selfUpdateDisabled: false },
    './appUpdater': { downloadAppUpdate: async () => ({ filePath: 'synthetic-installer', handoff: true }),
      launchAppUpdate: async () => {
        retainedAtLaunch = owners.every(owner => !owner.registry.isClosed)
        if (refuse) throw new Error('Installer refused launch')
      } }
  })
  registerUpdateHandlers(() => host.windows[0], host.coordinator, approved)
  const event = { sender: host.windows[0].webContents }
  const downloaded = await handlers.get('novalist:download-app-update')(event, {})
  await assert.rejects(handlers.get('novalist:launch-app-update')(event, downloaded.launchToken), /Installer refused launch/)
  assert.equal(retainedAtLaunch, true)
  assert.equal(quit, false)
  assert.equal(approved.size, 0)
  assert.equal(host.events.some(([, stage]) => stage === 'commit'), false)
  for (const owner of owners) await assertRetainedUndo(owner)
  refuse = false
  const retry = await handlers.get('novalist:download-app-update')(event, {})
  await handlers.get('novalist:launch-app-update')(event, retry.launchToken)
  assert.equal(retainedAtLaunch, true)
  assert.equal(quit, true)
  assert.equal(approved.size, 2)
  for (const owner of owners) {
    assert.equal(owner.registry.isClosed, true)
    assert.equal(owner.shared.isClosed, true)
    owner.server.destroy()
  }
  dom.window.close()
})

test('the production close caller handles quit escalation before and during detached commitment without resuming disposed owners', async () => {
  for (const heldStage of ['release', 'commit']) {
    const dom = new JSDOM('')
    const owners = await Promise.all([1, 2].map(id => windowOwner(dom.window.document, id)))
    const host = closeHost(owners), approved = new Set()
    let quit = false, release, signalHeld
    const gate = new Promise(resolve => { release = resolve })
    const held = new Promise(resolve => { signalHeld = resolve })
    host.setStageHook(async (owner, stage) => {
      if (owner === 2 && stage === heldStage) { signalHeld(); await gate }
      return owner !== 1 || stage !== 'flush'
    })
    const caller = new WindowCloseRequests(host.coordinator, {
      getMainWindow: () => host.windows[0], getWindows: () => host.windows.filter(window => !window.isDestroyed()),
      approvedCloses: approved, quit: () => { quit = true }
    })
    const detached = caller.request(host.windows[1], false)
    const failed = assert.rejects(detached, /could not save/)
    await held
    assert.equal(caller.request(host.windows[0], true), detached)
    release()
    await failed
    assert.equal(quit, false)
    await assertRetainedUndo(owners[0])
    if (heldStage === 'release') {
      await assertRetainedUndo(owners[1])
      assert.equal(host.windows[1].isDestroyed(), false)
      assert.equal(approved.size, 0)
      assert.equal(host.events.some(([, stage]) => stage === 'commit'), false)
    } else {
      assert.equal(host.windows[1].isDestroyed(), true)
      assert.equal(owners[1].registry.isClosed, true)
      assert.equal(owners[1].shared.isClosed, true)
      assert.equal(approved.has(2), true)
      assert.ok(host.events.findIndex(([id, stage]) => id === 2 && stage === 'closed') < host.events.findIndex(([id, stage]) => id === 1 && stage === 'flush'))
      assert.equal(host.events.some(([id, stage]) => id === 2 && stage === 'abort'), false)
    }
    for (const owner of owners) { if (!owner.registry.isClosed) (await owner.prepare())(); owner.server.destroy() }
    dom.window.close()
  }
})

test('a second window veto or timeout preserves actual registry and shared undo owners in both windows', async () => {
  for (const failure of ['veto', 'timeout']) {
    const dom = new JSDOM('')
    const owners = await Promise.all([1, 2].map(id => windowOwner(dom.window.document, id)))
    const stages = [], releases = new Map()
    const coordinator = new WindowCloseCoordinator(80)
    for (const [index, owner] of owners.entries()) coordinator.register(index + 1, {
      send(token, stage) {
        stages.push([index + 1, stage])
        void (async () => {
          if (stage === 'abort') { releases.delete(index); coordinator.acknowledge(index + 1, token, true); return }
          if (stage === 'flush') { await owner.registry.flush(); await owner.shared.flush() }
          if (stage === 'release') {
            releases.set(index, await owner.prepare())
            if (index === 1 && failure === 'timeout') return
            if (index === 1) { coordinator.acknowledge(index + 1, token, false); return }
          }
          if (stage === 'commit') releases.get(index)()
          coordinator.acknowledge(index + 1, token, true)
        })().catch(() => coordinator.acknowledge(index + 1, token, false))
      }, focus() {}
    })
    await assert.rejects(coordinator.prepare([1, 2], 1), /could not save|did not respond/)
    assert.equal(stages.some(([, stage]) => stage === 'commit'), false)
    assert.deepEqual(stages.filter(([, stage]) => stage === 'abort'), [[1, 'abort'], [2, 'abort']])
    for (const owner of owners) {
      assert.equal(getWritingDocumentRegistry(owner.options), owner.registry)
      assert.equal(getWritingHistory(owner.registry), owner.history)
      assert.equal(owner.shared.isClosed, false)
      assert.equal((await owner.history.undo()).status, 'applied')
      assert.equal(owner.registry.getSnapshot(owner.ref).html, 'Original')
      owner.shared.undo()
      assert.equal(owner.shared.prose.toString(), 'Shared\n')
      const commit = await owner.prepare()
      assert.equal(owner.registry.isClosed, false)
      assert.equal(commit(), undefined)
      commit()
      assert.equal(owner.registry.isClosed, true)
      assert.equal(owner.shared.isClosed, true)
      owner.server.destroy()
    }
    dom.window.close()
  }
})
