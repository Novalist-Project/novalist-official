import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const bundle = await build({
  stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx', contents: `
    import { renderToStaticMarkup } from 'react-dom/server'
    import { CollaborationToolbar } from './src/renderer/src/collaboration/CollaborationToolbar'
    import { useHostedSessionStore } from './src/renderer/src/collaboration/hostedSessionStore'
    export const render = value => { useHostedSessionStore.setState(value); return renderToStaticMarkup(<CollaborationToolbar />) }
  ` },
  bundle: true, write: false, platform: 'node', format: 'iife', globalName: 'fixture', jsx: 'automatic',
  external: ['react', 'react-dom/server'], loader: { '.css': 'empty' },
  plugins: [{ name: 'toolbar-boundaries', setup(build) {
    build.onResolve({ filter: /^(react-i18next|.*\/(hostedSessionStore|shellStore|projectStore|useDialogKeyboard|CollaborationCard))$/ }, args => ({
      path: args.path.endsWith('/hostedSessionStore') ? '/hostedSessionStore' : args.path, namespace: 'fixture'
    }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents:
      path === 'react-i18next' ? 'export const useTranslation = () => ({ t: key => key })' :
      path.endsWith('/hostedSessionStore') ? 'let state; export const useHostedSessionStore = selector => selector(state); useHostedSessionStore.setState = value => { state = value }' :
      path.endsWith('/shellStore') ? 'export const useShellStore = selector => selector({ backendVersion: "3.7.2", mainView: "editor" })' :
      path.endsWith('/projectStore') ? 'export const useProjectStore = selector => selector({ projectPath: "/project" })' :
      path.endsWith('/useDialogKeyboard') ? 'export const useDialogKeyboard = () => ({})' :
      'export const CollaborationCard = () => null' }))
  } }]
})
const { render } = new Function('require', bundle.outputFiles[0].text + '; return fixture')(createRequire(import.meta.url))

for (const connection of ['Connected', 'Connecting', 'Reconnecting', 'Stopped', 'Failed', 'AccessEnded', 'KeyRefreshRequired']) {
  test(`closed collaboration toolbar exposes ${connection}`, () => {
    const html = render({ session: { connection, isOwner: true }, busy: null, hostSynchronizing: false })
    assert.ok(html.includes(`data-connection="${connection}"`))
    assert.ok(html.includes(`aria-label="collaboration.connection.${connection}"`))
    assert.ok(html.includes('aria-expanded="false"'))
    assert.ok(!html.includes('role="dialog"'))
  })
}

test('no session has no connection dot', () => {
  assert.ok(!render({ session: null, busy: null, hostSynchronizing: false }).includes('collaboration-connection-dot'))
})

test('session setup and host synchronization override a connected indicator', () => {
  const session = { connection: 'Connected', isOwner: true }
  const joining = render({ session, busy: 'join', hostSynchronizing: false })
  assert.ok(joining.includes('data-connection="Connecting"'))
  assert.ok(joining.includes('aria-label="collaboration.progress.join"'))
  const hosting = render({ session, busy: null, hostSynchronizing: true })
  assert.ok(hosting.includes('data-connection="Connecting"'))
  assert.ok(hosting.includes('aria-label="collaboration.transfer.hostSynchronizing"'))
})
