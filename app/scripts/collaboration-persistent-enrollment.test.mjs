import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { resolve } from 'node:path'
import { identityProvider } from '../e2e/fixtures/identityProvider.ts'
import { collaborationServer } from '../e2e/fixtures/collaborationServer.ts'
import { persistentDatabase } from './collaboration-persistent-database.mjs'

function device() {
  const signing = generateKeyPairSync('ed25519')
  const receiving = generateKeyPairSync('x25519')
  const publicKey = key => Buffer.from(key.export({ format: 'jwk' }).x, 'base64url')
  const signingPublicKey = publicKey(signing.publicKey)
  const receivingPublicKey = publicKey(receiving.publicKey)
  const id = createHash('sha256').update(Buffer.concat([Buffer.from('novalist/v1/device-id'), signingPublicKey, receivingPublicKey])).digest().subarray(0, 16)
  id[6] = (id[6] & 0x0f) | 0x80
  id[8] = (id[8] & 0x3f) | 0x80
  const hex = id.toString('hex')
  return { signing: signing.privateKey, id, keys: { deviceId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    signingPublicKey: signingPublicKey.toString('base64'), receivingPublicKey: receivingPublicKey.toString('base64') } }
}

async function tokens(authority, nonce) {
  const verifier = randomBytes(32).toString('base64url')
  const redirect = 'http://127.0.0.1:19444/callback'
  const authorize = new URL(authority + '/authorize')
  authorize.search = new URLSearchParams({ redirect_uri: redirect, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), state: 'test', nonce, max_age: '0' }).toString()
  const authorized = await fetch(authorize, { redirect: 'manual' })
  assert.equal(authorized.status, 302)
  const code = new URL(authorized.headers.get('location')).searchParams.get('code')
  const response = await fetch(authority + '/token', { method: 'POST', body: new URLSearchParams({
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: 'novalist', redirect_uri: redirect
  }) })
  assert.equal(response.status, 200)
  return response.json()
}

test('the manual identity provider completes real persistent-server MFA device enrollment', {
  skip: process.env.NOVALIST_SYNC_INTEGRATION !== '1', timeout: 120_000
}, async context => {
  const source = resolve(process.env.NOVALIST_SYNC_SERVER_SOURCE ?? 'out/collaboration-sync-server')
  const subject = 'enrollment-smoke-' + randomUUID()
  const identity = await identityProvider(() => subject, () => 'Enrollment test writer', 0, false, undefined, { simulateMfa: true })
  let database
  let server
  try {
    database = await persistentDatabase(source, context.signal, 'out/persistent-enrollment-tests')
    server = await collaborationServer(identity.address, 0, undefined, { source, connectionString: database.connectionString })
    const login = await tokens(identity.address, randomUUID())
    const authorization = { Authorization: 'Bearer ' + login.access_token }
    const registration = await fetch(server.address + '/devices/registration', { headers: authorization }).then(response => response.json())
    const ordinary = device()
    const recovery = device()
    const challengeResponse = await fetch(server.address + '/devices/enrollment', { method: 'POST',
      headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: ordinary.keys, recoveryKeys: recovery.keys }) })
    assert.equal(challengeResponse.status, 200)
    const challenge = await challengeResponse.json()
    const proofToken = await tokens(identity.address, challenge.nonce)
    const address = Buffer.from(server.address + '/')
    const length = Buffer.alloc(2)
    length.writeUInt16BE(address.length)
    const proof = identity => Buffer.concat([Buffer.from('novalist/v1/device-register'), length, address,
      Buffer.from(registration.userId.replaceAll('-', ''), 'hex'), identity.id,
      Buffer.from(identity.keys.signingPublicKey, 'base64'), Buffer.from(identity.keys.receivingPublicKey, 'base64')])
    const signature = (key, bytes) => sign(null, bytes, key).toString('base64')
    const response = await fetch(server.address + '/devices/verified', { method: 'PUT',
      headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({
        keys: ordinary.keys, signature: signature(ordinary.signing, proof(ordinary)),
        recoveryDevice: { keys: recovery.keys, signature: signature(recovery.signing, proof(recovery)),
          linkingSignature: signature(ordinary.signing, Buffer.concat([Buffer.from('novalist/v1/device-link'), ordinary.id, proof(recovery)])) },
        enrollmentProof: { challengeId: challenge.id, identityToken: proofToken.id_token }
      }) })
    assert.ok(response.ok, await response.text())
  } finally {
    try { await server?.close() }
    finally { try { await database?.close() } finally { await identity.close() } }
  }
})
