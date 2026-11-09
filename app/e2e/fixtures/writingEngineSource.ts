export function scopeEditorSource(name: string, source: string): string {
  const changes: Record<string, [string, string][]> = {
    'content-input.js': [
      ['function getCleanContentHtml() {', 'function getCleanContentHtml(root = window.NovalistEditorState.editor) {'],
      ['const clone = window.NovalistEditorState.editor.cloneNode(true);', 'const clone = root.cloneNode(true);']
    ],
    'grammar-highlights.js': [
      ['function buildGrammarPlainTextMap() {', 'function buildGrammarPlainTextMap(root = window.NovalistEditorState.editor) {'],
      ['window.NovalistEditorState.editor.childNodes', 'root.childNodes']
    ]
  }
  for (const [before, after] of changes[name] ?? []) {
    if (!source.includes(before)) throw new Error('The experimental editor seam no longer matches the source engine.')
    source = source.replaceAll(before, after)
  }
  return source
}
