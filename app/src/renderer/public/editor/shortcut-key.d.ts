export interface ShortcutKeyEvent {
  key: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  isComposing?: boolean
  keyCode?: number
  altGraph?: boolean
  getModifierState?(key: string): boolean
}

declare global {
  var NovalistShortcutKeys: { key(event: ShortcutKeyEvent): string | null }
}
