import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { identityProvider, introspectionClient } from '../e2e/fixtures/identityProvider.ts'

test('the local identity provider introspects issued tokens and account disablement', async () => {
  const identity = await identityProvider()
  try {
    const verifier = randomBytes(32).toString('base64url')
    const redirect = 'http://127.0.0.1:19444/callback'
    const authorize = new URL(identity.address + '/authorize')
    authorize.search = new URLSearchParams({ redirect_uri: redirect, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), state: 'test' }).toString()
    const authorized = await fetch(authorize, { redirect: 'manual' })
    assert.equal(authorized.status, 302)
    const code = new URL(authorized.headers.get('location')).searchParams.get('code')
    const response = await fetch(identity.address + '/token', { method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: 'novalist', redirect_uri: redirect
    }) })
    assert.equal(response.status, 200)
    const token = (await response.json()).access_token
    const introspect = (value, secret = introspectionClient.secret) => fetch(identity.address + '/introspect', {
      method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(introspectionClient.id + ':' + secret).toString('base64') },
      body: new URLSearchParams({ token: value })
    })
    assert.equal((await introspect(token, 'incorrect-test-secret')).status, 401)
    const active = await (await introspect(token)).json()
    assert.equal(active.active, true)
    assert.equal(active.sub, 'writer')
    assert.equal(active.iss, identity.address)
    assert.deepEqual(await (await introspect(token + 'altered')).json(), { active: false })
    identity.disable('writer')
    assert.deepEqual(await (await introspect(token)).json(), { active: false })
  } finally { await identity.close() }
})

test('persistent manual sign-in chooses writers in the browser and simulates fresh MFA', async () => {
  const identity = await identityProvider(undefined, subject => subject, 0, false, undefined,
    { accounts: { owner: 'Morgan', guest: 'Alex <Guest>' }, simulateMfa: true })
  try {
    const verifier = randomBytes(32).toString('base64url')
    const redirect = 'http://127.0.0.1:19444/callback'
    const authorize = new URL(identity.address + '/authorize')
    authorize.search = new URLSearchParams({ redirect_uri: redirect, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), state: 'test', nonce: 'enrollment-nonce', max_age: '0' }).toString()
    const choices = await fetch(authorize)
    assert.equal(choices.status, 200)
    const html = await choices.text()
    assert.ok(html.includes('Alex &lt;Guest&gt;'))
    assert.ok(html.includes('simulates multi-factor authentication'))
    authorize.searchParams.set('account', 'unknown')
    assert.equal((await fetch(authorize)).status, 400)
    authorize.searchParams.set('account', 'guest')
    const authorized = await fetch(authorize, { redirect: 'manual' })
    assert.equal(authorized.status, 302)
    const code = new URL(authorized.headers.get('location')).searchParams.get('code')
    const response = await fetch(identity.address + '/token', { method: 'POST', body: new URLSearchParams({
      grant_type: 'authorization_code', code, code_verifier: verifier, client_id: 'novalist', redirect_uri: redirect
    }) })
    assert.equal(response.status, 200)
    const claims = JSON.parse(Buffer.from((await response.json()).id_token.split('.')[1], 'base64url').toString())
    assert.equal(claims.sub, 'guest')
    assert.equal(claims.nonce, 'enrollment-nonce')
    assert.deepEqual(claims.amr, ['mfa'])
    assert.ok(Math.abs(Date.now() / 1000 - claims.auth_time) < 5)
  } finally { await identity.close() }
})
