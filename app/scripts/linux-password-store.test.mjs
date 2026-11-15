import assert from 'node:assert/strict'
import test from 'node:test'
import { linuxPasswordStoreSwitch, parseBusNames, sessionBusNames } from '../src/main/linux-password-store.ts'

const secretService = () => new Set(['org.freedesktop.DBus', 'org.freedesktop.secrets'])
const unreachable = () => { throw new Error('the session bus must not be asked') }

test('desktops Chromium maps to a keyring keep its own choice without asking the bus', () => {
  const recognised = [
    { XDG_CURRENT_DESKTOP: 'GNOME' }, { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, { XDG_CURRENT_DESKTOP: 'Unity' },
    { XDG_CURRENT_DESKTOP: 'X-Cinnamon' }, { XDG_CURRENT_DESKTOP: 'XFCE' }, { XDG_CURRENT_DESKTOP: 'Pantheon' },
    { XDG_CURRENT_DESKTOP: 'UKUI' }, { XDG_CURRENT_DESKTOP: 'Deepin' },
    { XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' }, { XDG_CURRENT_DESKTOP: 'KDE' },
    { DESKTOP_SESSION: 'mate' }, { DESKTOP_SESSION: 'gnome' }, { DESKTOP_SESSION: 'xubuntu' }, { DESKTOP_SESSION: 'xfce4' },
    { DESKTOP_SESSION: 'deepin' }, { DESKTOP_SESSION: 'ukui' }, { DESKTOP_SESSION: 'kde-plasma' }, { DESKTOP_SESSION: 'kde4' },
    { DESKTOP_SESSION: 'kde', KDE_SESSION_VERSION: '5' },
    { GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated' }, { KDE_FULL_SESSION: 'true', KDE_SESSION_VERSION: '6' },
    { KDE_FULL_SESSION: 'true', KDE_SESSION_VERSION: '5' }
  ]
  for (const env of recognised)
    assert.equal(linuxPasswordStoreSwitch('linux', env, false, unreachable), null, JSON.stringify(env))
})

test('desktop names match Chromium exactly rather than by substring', () => {
  for (const env of [{ XDG_CURRENT_DESKTOP: 'gnome' }, { XDG_CURRENT_DESKTOP: 'Hyprland' }, { DESKTOP_SESSION: 'plasma-kde' },
    { XDG_CURRENT_DESKTOP: 'LXQt', DESKTOP_SESSION: 'gnome' }, { XDG_CURRENT_DESKTOP: 'COSMIC' },
    { DESKTOP_SESSION: 'kde' }, { KDE_FULL_SESSION: 'true' }, {}])
    assert.equal(linuxPasswordStoreSwitch('linux', env, false, secretService), 'gnome-libsecret', JSON.stringify(env))
})

test('unrecognised desktops use the keyring service running on the session bus', () => {
  const env = { XDG_CURRENT_DESKTOP: 'Hyprland' }
  assert.equal(linuxPasswordStoreSwitch('linux', env, false, secretService), 'gnome-libsecret')
  assert.equal(linuxPasswordStoreSwitch('linux', env, false, () => new Set(['org.kde.kwalletd6', 'org.kde.kwalletd5'])), 'kwallet6')
  assert.equal(linuxPasswordStoreSwitch('linux', env, false, () => new Set(['org.kde.kwalletd5'])), 'kwallet5')
  assert.equal(linuxPasswordStoreSwitch('linux', env, false, () => new Set(['org.kde.kwalletd6', 'org.freedesktop.secrets'])), 'gnome-libsecret')
})

test('no keyring service leaves Chromium alone, and an unreachable bus falls back to libsecret', () => {
  const env = { XDG_CURRENT_DESKTOP: 'sway' }
  assert.equal(linuxPasswordStoreSwitch('linux', env, false, () => new Set(['org.freedesktop.DBus'])), null)
  assert.equal(linuxPasswordStoreSwitch('linux', env, false, () => null), 'gnome-libsecret')
})

test('an explicit --password-store and other platforms are left alone', () => {
  assert.equal(linuxPasswordStoreSwitch('linux', { XDG_CURRENT_DESKTOP: 'Hyprland' }, true, unreachable), null)
  assert.equal(linuxPasswordStoreSwitch('darwin', {}, false, unreachable), null)
  assert.equal(linuxPasswordStoreSwitch('win32', {}, false, unreachable), null)
})

test('bus names are read from dbus-send replies', () => {
  const reply = 'method return time=1 sender=org.freedesktop.DBus -> destination=:1.9 serial=3 reply_serial=2\n' +
    '   array [\n      string "org.freedesktop.DBus"\n      string ":1.4"\n      string "org.freedesktop.secrets"\n   ]\n'
  assert.deepEqual([...parseBusNames(reply)], ['org.freedesktop.DBus', ':1.4', 'org.freedesktop.secrets'])
})

test('running and activatable names are combined, and a failed query reports no answer', () => {
  const calls = []
  const names = sessionBusNames(args => {
    calls.push(args.at(-1))
    return args.at(-1).endsWith('.ListNames') ? '   string "org.kde.kwalletd6"\n' : '   string "org.freedesktop.secrets"\n'
  })
  assert.deepEqual(calls, ['org.freedesktop.DBus.ListNames', 'org.freedesktop.DBus.ListActivatableNames'])
  assert.deepEqual([...names].sort(), ['org.freedesktop.secrets', 'org.kde.kwalletd6'])
  assert.equal(sessionBusNames(() => { throw new Error('dbus-send: not found') }), null)
})
