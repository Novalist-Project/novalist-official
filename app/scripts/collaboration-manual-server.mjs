import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'
import { fileURLToPath } from 'node:url'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { identityProvider } from '../e2e/fixtures/identityProvider.ts'
import { collaborationServer } from '../e2e/fixtures/collaborationServer.ts'
import { persistentDatabase } from './collaboration-persistent-database.mjs'

process.chdir(fileURLToPath(new URL('..', import.meta.url)))
const accounts = { owner: 'Morgan', guest: 'Alex', third: 'Sam' }
let account = 'owner'
const port = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a port between 1 and 65535.`)
  return value
}
const anonymous = process.argv.includes('--anonymous')
const persistent = process.argv.includes('--persistent')
if (persistent && anonymous) throw new Error('Persistent test hosting requires account sign-in.')
const sourceIndex = process.argv.indexOf('--server-source')
if (sourceIndex !== -1 && (!process.argv[sourceIndex + 1] || process.argv[sourceIndex + 1].startsWith('--')))
  throw new Error('Pass the novalist-sync-server checkout path after --server-source.')
const source = resolve(sourceIndex === -1 ? process.env.NOVALIST_SYNC_SERVER_SOURCE ?? 'out/collaboration-sync-server' : process.argv[sourceIndex + 1])
await access(resolve(source, 'src/Novalist.Sync.Server/Novalist.Sync.Server.csproj')).catch(error => {
  throw new Error('Choose your novalist-sync-server checkout with --server-source or NOVALIST_SYNC_SERVER_SOURCE.', { cause: error })
})
const relayPort = persistent ? port('NOVALIST_COLLAB_PERSISTENT_PORT', 42672) : port('NOVALIST_COLLAB_RELAY_PORT', 42670)
const cancellation = new AbortController()
const stop = () => cancellation.abort()
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
let identity
let database
let server
try {
  if (!anonymous) {
    const identityPort = persistent ? port('NOVALIST_COLLAB_PERSISTENT_IDENTITY_PORT', 42673) : port('NOVALIST_COLLAB_IDENTITY_PORT', 42671)
    if (relayPort === identityPort) throw new Error('The collaboration server and sign-in provider need different ports.')
    identity = await identityProvider(() => account, subject => accounts[subject], identityPort, false, undefined,
      persistent ? { accounts, simulateMfa: true } : {})
  }
  if (persistent) database = await persistentDatabase(source, cancellation.signal)
  cancellation.signal.throwIfAborted()
  server = await collaborationServer(identity?.address ?? null, relayPort, undefined, { source, connectionString: database?.connectionString })
  console.log(`Local test server: ${server.address}`)
  console.log('Use the Local test server URL above under Collaborate in the top bar of both apps.')
  if (identity) {
    console.log(`Browser sign-in only (do not enter this as the relay address): ${identity.address}`)
    console.log('After restarting this helper, sign out and sign in again in each app before sharing.')
    if (persistent) {
      console.log('Choose Morgan, Alex or Sam in the browser. Select the same writer when registering their device.')
      console.log('The local test provider simulates MFA; no real password or second factor is needed.')
    } else {
      console.log('Next browser sign-in: Morgan (owner). No password is needed.')
      console.log('Enter owner, guest or third to choose the account for the next sign-in.')
    }
  } else console.log('No account required. Enter Your name in each app, then share or join directly.')
  if (persistent) {
    console.log('Select Persistent server in both apps, sign in, and choose Register this device before sharing or joining.')
    console.log('Encrypted projects and the PostgreSQL volume survive restarts. The owner can go offline after inviting another writer.')
    console.log('Keep this terminal running. Enter quit to stop the server and PostgreSQL without deleting test data.')
  } else {
    console.log('This server relays packets only; it stores no project data and needs no database.')
    console.log('Keep the host app and this terminal running for collaboration. Enter quit to stop the relay.')
  }
  const terminal = createInterface({ input: stdin, output: stdout, prompt: persistent ? 'server> ' : identity ? 'account> ' : 'relay> ' })
  const closeTerminal = () => terminal.close()
  cancellation.signal.addEventListener('abort', closeTerminal, { once: true })
  if (cancellation.signal.aborted) terminal.close()
  terminal.prompt()
  try {
    for await (const line of terminal) {
      const command = line.trim().toLowerCase()
      if (command === 'quit') break
      if (!persistent && identity && Object.hasOwn(accounts, command)) {
        account = command
        console.log(`Next browser sign-in: ${accounts[account]} (${account}).`)
      } else console.log(persistent ? 'Choose a test writer in the browser, or enter quit.' : identity ? 'Choose owner, guest, third, or quit.' : 'Enter quit to stop the relay.')
      terminal.prompt()
    }
  } finally {
    terminal.close()
    cancellation.signal.removeEventListener('abort', closeTerminal)
  }
} finally {
  try { await server?.close() }
  finally {
    try { await identity?.close() }
    finally {
      try { await database?.close() }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
    }
  }
}
