/**
 * Hands the host's colour scheme to a same-origin frame. The frame pages pin
 * dark for their first paint; once the host's scheme differs, Chromium paints
 * the frame's canvas opaque in the frame's own scheme, which covers whatever a
 * transparent page lets through (the Focus surround) and leaves its native
 * controls in the other palette.
 */
export function pushFrameColorScheme(frame: Window, token: (name: string) => string): void {
  frame.document.documentElement.style.colorScheme = token('--nl-color-scheme')
}
