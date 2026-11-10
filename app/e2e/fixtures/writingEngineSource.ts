import { installWritingViewport } from './writingViewport'
import { createHash } from 'node:crypto'
import { writingSpacingAttributes } from './writingPresentation'

export function scopeEditorSource(name: string, source: string): string {
  source = source.replaceAll('\r\n', '\n')
  const changes: Record<string, [string, string][]> = {
    'content-input.js': [
      ['function getCleanContentHtml() {', 'function getCleanContentHtml(root = window.NovalistEditorState.editor) {'],
      ['const clone = window.NovalistEditorState.editor.cloneNode(true);', `const clone = root.cloneNode(true); for (const name of ${JSON.stringify(writingSpacingAttributes)}) clone.querySelectorAll('[' + name + ']').forEach(node => node.removeAttribute(name));`]
    ],
    'grammar-highlights.js': [
      ['function buildGrammarPlainTextMap() {', 'function buildGrammarPlainTextMap(root = window.NovalistEditorState.editor) {'],
      ['window.NovalistEditorState.editor.childNodes', 'root.childNodes']
    ],
    'typewriter-scroll.js': [
      ['function recenterCaret() {', 'function recenterCaret() { return window.writingViewport.intent(() => {'],
      ['\n}\n\nObject.assign(window, {', '\n}); }\n\nObject.assign(window, {']
    ],
    'writing-zoom.js': [
      ['    window.setWritingZoom = (factor, anchor = typewriterAnchor) => {', '    window.setWritingZoom = (factor, anchor = typewriterAnchor) => window.writingViewport.intent(() => {'],
      ['        refresh();\n    };', '        refresh();\n    });']
    ]
  }
  for (const [before, after] of changes[name] ?? []) {
    if (!source.includes(before) || (['typewriter-scroll.js', 'writing-zoom.js'].includes(name) && source.split(before).length !== 2)) throw new Error('The experimental editor seam no longer matches the source engine.')
    source = source.replaceAll(before, after)
  }
  if (name === 'clipboard-focus-events.js') {
    const marker = '// Track scroll positions for focus-gain scroll jump prevention'
    const legacy = source.slice(source.indexOf(marker))
    if (source.split(marker).length !== 2 || createHash('sha256').update(legacy).digest('hex') !== '392cf1d4ee60fd1860127579c5639220fae7a2f08f8a47bcb068f002f047a816') throw new Error('The experimental focus seam no longer matches the source engine.')
    source = source.slice(0, source.indexOf(marker)) + `(${installWritingViewport.toString()})();\n`
  }
  return source
}
