import assert from 'node:assert/strict'
import test from 'node:test'
import { linuxPasswordStoreSwitch } from '../src/main/linux-password-store.ts'

test('unrecognised Linux desktops are pointed at the Secret Service keyring', () => {
  assert.equal(linuxPasswordStoreSwitch('linux', { XDG_CURRENT_DESKTOP: 'Hyprland' }, false), 'gnome-libsecret')
  assert.equal(linuxPasswordStoreSwitch('linux', { XDG_CURRENT_DESKTOP: 'sway' }, false), 'gnome-libsecret')
  assert.equal(linuxPasswordStoreSwitch('linux', {}, false), 'gnome-libsecret')
})

test('desktops Chromium already maps to a keyring keep its own choice', () => {
  for (const desktop of ['GNOME', 'ubuntu:GNOME', 'KDE', 'X-Cinnamon', 'XFCE', 'Pantheon', 'Unity', 'UKUI', 'Deepin'])
    assert.equal(linuxPasswordStoreSwitch('linux', { XDG_CURRENT_DESKTOP: desktop }, false), null, desktop)
  assert.equal(linuxPasswordStoreSwitch('linux', { DESKTOP_SESSION: 'plasma-kde' }, false), null)
})

test('an explicit --password-store and other platforms are left alone', () => {
  assert.equal(linuxPasswordStoreSwitch('linux', { XDG_CURRENT_DESKTOP: 'Hyprland' }, true), null)
  assert.equal(linuxPasswordStoreSwitch('darwin', {}, false), null)
  assert.equal(linuxPasswordStoreSwitch('win32', {}, false), null)
})
