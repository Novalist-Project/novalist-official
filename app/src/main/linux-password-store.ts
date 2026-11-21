import { execFileSync } from 'node:child_process'

/** The `--password-store` values Chromium accepts that this module may choose. */
export type PasswordStore = 'gnome-libsecret' | 'kwallet5' | 'kwallet6'

/** Session-bus names that are running or D-Bus activatable, or null when the bus cannot be asked. */
export type SessionBusNames = ReadonlySet<string> | null

// Mirrors Chromium's GetDesktopEnvironment (base/nix/xdg_util.cc) and the
// keyring its os_crypt selects for that desktop. Only these desktops get a
// keyring on their own; every other one (Hyprland, Sway, niri, COSMIC, LXQt,
// a bare X session, ...) silently gets plaintext "basic_text" storage, which
// the collaboration credential store refuses.
function chromiumKeyring(env: NodeJS.ProcessEnv): PasswordStore | null {
  const kdeWallet = (): PasswordStore => env.KDE_SESSION_VERSION === '6' ? 'kwallet6' : 'kwallet5'
  const session = env.DESKTOP_SESSION ?? ''
  for (const desktop of (env.XDG_CURRENT_DESKTOP ?? '').split(':').map(value => value.trim())) {
    if (['Unity', 'Deepin', 'GNOME', 'X-Cinnamon', 'Pantheon', 'XFCE', 'UKUI'].includes(desktop)) return 'gnome-libsecret'
    if (desktop === 'KDE') return kdeWallet()
    if (desktop === 'LXQt' || desktop === 'COSMIC') return null
  }
  if (['deepin', 'gnome', 'mate', 'ukui', 'xubuntu'].includes(session) || session.includes('xfce')) return 'gnome-libsecret'
  if (session === 'kde4' || session === 'kde-plasma') return 'kwallet5'
  if (session === 'kde') return env.KDE_SESSION_VERSION === undefined ? null : 'kwallet5'
  if (env.GNOME_DESKTOP_SESSION_ID !== undefined) return 'gnome-libsecret'
  if (env.KDE_FULL_SESSION !== undefined) return env.KDE_SESSION_VERSION === undefined ? null : kdeWallet()
  return null
}

/**
 * The `--password-store` value to add at startup, or null to leave Chromium's
 * own choice alone: not Linux, a store already chosen, a desktop Chromium maps
 * to a keyring itself, or no keyring service on the session bus to point at.
 * The bus is asked only when Chromium would otherwise fall back to plaintext.
 */
export function linuxPasswordStoreSwitch(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  hasSwitch: boolean,
  busNames: () => SessionBusNames
): PasswordStore | null {
  if (platform !== 'linux' || hasSwitch || chromiumKeyring(env)) return null
  const names = busNames()
  // Without a bus to ask, libsecret is the most widely provided keyring.
  if (!names || names.has('org.freedesktop.secrets')) return 'gnome-libsecret'
  if (names.has('org.kde.kwalletd6')) return 'kwallet6'
  if (names.has('org.kde.kwalletd5')) return 'kwallet5'
  return null
}

/** Reads the names `dbus-send --print-reply` lists, one `string "<name>"` per entry. */
export function parseBusNames(reply: string): Set<string> {
  return new Set(Array.from(reply.matchAll(/^\s*string "([^"]+)"$/gm), match => match[1]))
}

/**
 * Asks the session bus which names are running or activatable. Runs before
 * Electron is ready, so it is synchronous and bounded by a short timeout.
 */
export function sessionBusNames(run: (args: string[]) => string = dbusSend): SessionBusNames {
  try {
    const names = new Set<string>()
    for (const method of ['ListNames', 'ListActivatableNames'])
      for (const name of parseBusNames(run([
        '--session', '--print-reply', '--reply-timeout=1000', '--dest=org.freedesktop.DBus',
        '/org/freedesktop/DBus', `org.freedesktop.DBus.${method}`
      ]))) names.add(name)
    return names
  } catch {
    return null
  }
}

// Native process launch: exercised by the real app, not by the unit tests.
function dbusSend(args: string[]): string {
  return execFileSync('dbus-send', args, { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] })
}
