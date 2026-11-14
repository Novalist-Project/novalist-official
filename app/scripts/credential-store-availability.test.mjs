import assert from 'node:assert/strict'
import test from 'node:test'
import { credentialStoreProblem } from '../src/main/collaboration/credentialStoreAvailability.ts'

test('a Linux keyring backend protects credentials', () => {
  for (const backend of ['gnome_libsecret', 'kwallet5', 'kwallet6'])
    assert.equal(credentialStoreProblem('linux', true, backend), null, backend)
})

test('plaintext or missing Linux storage tells the writer which keyrings to start', () => {
  for (const [available, backend] of [[true, 'basic_text'], [true, 'unknown'], [false, 'gnome_libsecret']]) {
    const problem = credentialStoreProblem('linux', available, backend)
    assert.match(problem, /unlocked system keyring/, backend)
    assert.match(problem, /GNOME Keyring, KeePassXC \(with Secret Service enabled\) or KWallet, then restart Novalist\./)
  }
})

test('other platforms report only whether encryption is available', () => {
  assert.equal(credentialStoreProblem('darwin', true, ''), null)
  assert.equal(credentialStoreProblem('win32', true, ''), null)
  assert.equal(credentialStoreProblem('win32', false, ''), 'The operating system credential store is unavailable.')
})
