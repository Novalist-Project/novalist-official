// Every saved update becomes its own encrypted, numbered envelope on the server, which
// keeps it until the next key rotation. Merging a burst of keystrokes keeps that log small.
export const SHARED_WRITE_DELAY_MS = 250
