import { installWritingViewport } from './writingViewport'
import { createHash } from 'node:crypto'
import { writingSpacingAttributes } from './writingPresentation'
import { sceneCommentSource } from './writingCommentSource'

export function scopeEditorSource(name: string, source: string, fragments = false): string {
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
  if (fragments || name === 'grammar-highlights.js') {
    const edits: Record<string, [string, string][]> = {
      'grammar-highlights.js': [
        ['function buildGrammarPlainTextMap(root = window.NovalistEditorState.editor) {', 'function buildGrammarPlainTextMap(root = window.NovalistEditorState.editor, nodes = root.childNodes) {'],
        ['root.childNodes.length', 'nodes.length'],
        ['root.childNodes[i]', 'nodes[i]'],
        ['return { block, offset: before.toString().length };', 'return { block, offset: before.toString().length, live: { node, offset, value: node.textContent } };'],
        ['function textPointInElement(element, offset) {', 'function textPointInElement(element, offset, affinity = "backward") {'],
        ['if (offset <= node.length) return { node, offset };', 'if (offset < node.length || (offset === node.length && affinity === "backward")) return { node, offset };'],
        ['    const anchor = textPointInElement(saved.anchor.block, saved.anchor.offset);\n    const focus = textPointInElement(saved.focus.block, saved.focus.offset);', `    const resolve = point => {
        const live = point.live;
        if (live && live.node.nodeType === Node.TEXT_NODE && window.NovalistEditorState.editor.contains(live.node)
            && live.node.textContent === live.value) return live;
        return textPointInElement(point.block, point.offset, live && live.node.nodeType === Node.TEXT_NODE && live.offset === 0 ? "forward" : "backward");
    };
    const anchor = resolve(saved.anchor);
    const focus = resolve(saved.focus);`]
      ],
      'content-input.js': [
        ['function getCleanContentHtml(root = window.NovalistEditorState.editor) {', 'function getCleanContentHtml(root = window.NovalistEditorState.editor, unwrapPresentation = true) {'],
        ['if (window.NovalistEditorState.pageViewEnabled) {', 'if (unwrapPresentation && window.NovalistEditorState.pageViewEnabled) {']
      ]
    }
    for (const [before, after] of edits[name] ?? []) {
      if (source.split(before).length !== 2) throw new Error('The fragment engine seam no longer matches its exact source.')
      source = source.replace(before, after)
    }
  }
  return sceneCommentSource(name, source)
}
