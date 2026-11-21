import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'

async function availablePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function launch(env, signal, args = []) {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'scripts/collaboration-manual-server.mjs', ...args], {
    env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
  })
  let output = ''
  let errors = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk })
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`Helper exited with ${code}: ${output}\n${errors}`)))
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk
      const match = /Local test server: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)
      if (match) resolve(match[1])
    })
  })
  const stop = async () => {
    if (child.exitCode !== null) return
    const exited = once(child, 'exit', { signal })
    child.stdin.end('quit\n')
    await exited
  }
  try { return { address: await ready, stop } }
  catch (error) { await stop(); throw error }
}

test('the manual relay keeps both endpoints stable across restart and stops them together', {
  skip: process.env.NOVALIST_SYNC_INTEGRATION !== '1', timeout: 20_000
}, async context => {
  const relayPort = await availablePort()
  const identityPort = await availablePort()
  const env = { NOVALIST_COLLAB_RELAY_PORT: String(relayPort), NOVALIST_COLLAB_IDENTITY_PORT: String(identityPort) }
  const expected = `http://127.0.0.1:${relayPort}`
  const authority = `http://127.0.0.1:${identityPort}`
  for (let attempt = 0; attempt < 2; attempt++) {
    const server = await launch(env, context.signal)
    try {
      assert.equal(server.address, expected)
      const configuration = await fetch(expected + '/client-configuration').then(response => response.json())
      assert.equal(configuration.authority.replace(/\/$/, ''), authority)
      assert.equal((await fetch(authority + '/.well-known/openid-configuration')).status, 200)
      assert.equal((await fetch(authority + '/client-configuration')).status, 404,
        'The sign-in helper must not advertise itself as a collaboration server')
    } finally { await server.stop() }
    await assert.rejects(fetch(expected + '/client-configuration'))
    await assert.rejects(fetch(authority + '/.well-known/openid-configuration'))
  }
})

test('the persistent manual stack migrates PostgreSQL, accepts sign-in and keeps database identity across restart', {
  skip: process.env.NOVALIST_SYNC_INTEGRATION !== '1', timeout: 180_000
}, async context => {
  const serverPort = await availablePort()
  const identityPort = await availablePort()
  const postgresPort = await availablePort()
  const env = { NOVALIST_COLLAB_PERSISTENT_PORT: String(serverPort), NOVALIST_COLLAB_PERSISTENT_IDENTITY_PORT: String(identityPort),
    NOVALIST_COLLAB_POSTGRES_PORT: String(postgresPort), NOVALIST_COLLAB_TEST_DATA_DIR: 'out/persistent-launch-tests' }
  const authority = `http://127.0.0.1:${identityPort}`
  let previousUser
  for (let attempt = 0; attempt < 2; attempt++) {
    const server = await launch(env, context.signal, ['--persistent'])
    try {
      const configuration = await fetch(server.address + '/client-configuration').then(response => response.json())
      assert.equal(configuration.authenticationRequired, true)
      const verifier = randomBytes(32).toString('base64url')
      const redirect = 'http://127.0.0.1:19444/callback'
      const authorize = new URL(authority + '/authorize')
      authorize.search = new URLSearchParams({ account: 'owner', redirect_uri: redirect, code_challenge_method: 'S256',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), state: 'test', nonce: 'test' }).toString()
      const authorized = await fetch(authorize, { redirect: 'manual' })
      const code = new URL(authorized.headers.get('location')).searchParams.get('code')
      const token = await fetch(authority + '/token', { method: 'POST', body: new URLSearchParams({
        grant_type: 'authorization_code', code, code_verifier: verifier, client_id: 'novalist', redirect_uri: redirect
      }) }).then(response => response.json())
      const response = await fetch(server.address + '/devices/registration', { headers: { Authorization: 'Bearer ' + token.access_token } })
      assert.equal(response.status, 200)
      const registration = await response.json()
      assert.equal(registration.serverUrl, server.address + '/')
      if (previousUser) assert.equal(registration.userId, previousUser)
      previousUser = registration.userId
    } finally { await server.stop() }
    await assert.rejects(fetch(server.address + '/client-configuration'))
  }
})
