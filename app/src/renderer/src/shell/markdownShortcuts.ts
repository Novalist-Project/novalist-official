import { Prec, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import '../../public/editor/shortcut-key.js'

export const markdownShortcutKeys: Extension = Prec.highest(EditorView.domEventHandlers({
  keydown(event, view) {
    const key = globalThis.NovalistShortcutKeys.key(event)
    if (key === null || key === event.key.toLowerCase() || event.altKey ||
        !(event.ctrlKey || event.metaKey) || 'acvx'.includes(key)) return false
    const apple = /Mac|iPhone|iPad/.test(navigator.platform)
    for (const bindings of view.state.facet(keymap)) {
      for (const binding of bindings) {
        if (binding.scope && !binding.scope.split(' ').includes('editor')) continue
        const name = (apple ? binding.mac : /Win/.test(navigator.platform) ? binding.win : binding.linux) ?? binding.key
        if (!name) continue
        const parts = name.toLowerCase().split('-')
        if (parts.pop() !== key) continue
        const needMeta = parts.includes('meta') || (parts.includes('mod') && apple)
        const needCtrl = parts.includes('ctrl') || (parts.includes('mod') && !apple)
        if (event.metaKey !== needMeta || event.ctrlKey !== needCtrl || parts.includes('alt')) continue
        const shifted = parts.includes('shift')
        const command = event.shiftKey && !shifted ? binding.shift : event.shiftKey === shifted ? binding.run : undefined
        if (command?.(view) || (command && binding.preventDefault)) {
          if (binding.stopPropagation) event.stopPropagation()
          return true
        }
      }
    }
    return false
  }
}))
