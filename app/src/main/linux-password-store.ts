// Chromium only selects a keyring for desktops it recognises; anything else
// (Hyprland, Sway, niri, ...) silently gets plaintext "basic_text" storage,
// which the collaboration credential store refuses.
const recognisedDesktops = ['gnome', 'unity', 'x-cinnamon', 'cinnamon', 'pantheon', 'xfce', 'ukui', 'deepin', 'kde']

/**
 * The `--password-store` value to add at startup, or null to leave Chromium's
 * own choice alone (not Linux, a store already chosen, or a recognised desktop).
 */
export function linuxPasswordStoreSwitch(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, hasSwitch: boolean): string | null {
  if (platform !== 'linux' || hasSwitch) return null
  const desktops = [...(env.XDG_CURRENT_DESKTOP ?? '').split(':'), env.DESKTOP_SESSION ?? '']
    .map(name => name.trim().toLowerCase())
    .filter(Boolean)
  return desktops.some(name => recognisedDesktops.some(known => name.includes(known))) ? null : 'gnome-libsecret'
}
