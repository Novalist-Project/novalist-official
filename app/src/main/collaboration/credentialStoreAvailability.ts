/**
 * Why the operating system cannot protect collaboration credentials, worded
 * for the writer, or null when it can. Linux reports plaintext "basic_text"
 * (or "unknown") when no unlocked keyring answered at startup, and Chromium
 * keeps that choice until the app restarts.
 */
export function credentialStoreProblem(platform: NodeJS.Platform, encryptionAvailable: boolean, backend: string): string | null {
  if (platform === 'linux') {
    if (encryptionAvailable && !['basic_text', 'unknown'].includes(backend)) return null
    return 'Novalist could not find an unlocked system keyring to protect collaboration credentials. ' +
      'Start and unlock GNOME Keyring, KeePassXC (with Secret Service enabled) or KWallet, then restart Novalist.'
  }
  return encryptionAvailable ? null : 'The operating system credential store is unavailable.'
}
