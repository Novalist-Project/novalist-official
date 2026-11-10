import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sources: Record<string, string> = {
  projectStore: `import { create } from 'zustand'; export const useProjectStore = create(() => ({}));`,
  useUnifiedWritingDocument: `import { create } from 'zustand'; export const model = create(() => ({})); export const useUnifiedWritingDocument = () => model();`,
  filterStore: `import { create } from 'zustand'; export const useFilterStore = create(() => ({ filter: {} })); export const isEmptyFilter = () => true;`,
  manuscriptStore: `export const useManuscriptStore = { setState() {} };`,
  stageStore: `import { create } from 'zustand'; export const useStageStore = create(() => ({ stages: [{ key: 'revised', label: 'Revised', color: '#96baa5' }, { key: 'draft', label: 'Draft', color: '#d5ad50' }], setSceneStage: async (...args) => window.metadataWrites.push(['stage', ...args]) }));`,
  shellStore: `import { create } from 'zustand'; export const useShellStore = create(() => ({ suggestionMode: false, toggleInspector() {} }));`,
  settingsStore: `import { create } from 'zustand'; const book = new URLSearchParams(location.search).has('book'); export const useSettingsStore = create(() => ({ view: { effective: {
    pageViewEnabled: book, enableBookWidth: book, bookPageFormat: 'USTrade6x9',
    bookFontFamily: 'Times New Roman', bookFontSize: 11, editorFontFamily: book ? 'EB Garamond' : 'Georgia', editorFontSize: book ? 29 : 17
  } } }));`,
  dictationStore: `import { create } from 'zustand'; export const useDictation = create(() => ({ recording: false, starting: false }));`,
  DictationBar: `export const DictationBar = () => null;`,
  MotionPresence: `export const MotionPresence = ({ children }) => children; export const useMotionPresent = () => true;`,
  commands: `export const runCommand = command => window.commands.push(command);`,
  commandContext: `export const updateEditorSetting = patch => window.updateAppearanceSettings(patch);`,
  sharedWritingSessions: `export const getSharedWritingSession = () => { throw Error('Unexpected shared owner'); };`,
  writingStructure: `export const executeWritingStructure = async command => { window.metadataWrites.push(command); };`,
  hostBridgeStore: `export const useHostBridgeStore = { getState: () => ({ pushToast: message => { throw Error(message); } }) };`,
  sharedMarkdown: `export const openSharedMarkdown = async () => ({ text: 'Shared synopsis', extension: [], attach() {}, detach() {}, refresh: async () => {}, flush: async () => {} });`,
  SharedEditorPresence: `export class SharedEditorPresence { close() {} }`,
  i18n: `export default { t: key => key };`,
  client: `export const rpc = { request: async method => {
    if (method === 'scenes/getMeta') return { synopsis: 'Elara discovers a street on her father’s map that no longer exists.' };
    if (method === 'scenes/setSynopsis') return;
    throw Error('Unexpected RPC: ' + method);
  } };`,
  EditorFrame: `import React from 'react';
    import { EditorToolbar } from './src/renderer/src/views/editor/EditorToolbar';
    export const EditorFrame = ({ writing }) => <div className="editor-pane">
      <EditorToolbar writing={writing} active={true} speaking={false}
        formatting={{ paragraphStyle: '', alignment: 'left' }} />
      <iframe className="editor-frame" title="editor" src={window.editorUrl}
        onLoad={event => window.connectEditor(event.currentTarget.contentWindow)} />
    </div>;`
}

const entry = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { UnifiedWritingEditor } from './src/renderer/src/views/editor/UnifiedWritingEditor'
import { WritingDocumentRegistry } from './src/renderer/src/stores/writingDocuments'
import { useProjectStore } from './src/renderer/src/stores/projectStore'
import { model } from './src/renderer/src/views/editor/useUnifiedWritingDocument'
import { pushWritingTypography } from './src/renderer/src/views/editor/writingTypography'
import { useSettingsStore } from './src/renderer/src/stores/settingsStore'
import { useWritingZoomStore } from './src/renderer/src/stores/writingZoomStore'
import en from './src/renderer/src/locales/en.json'
import de from './src/renderer/src/locales/de.json'
const context = { workspaceId: '/appearance', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
const prose = '<p>By the time the bells rang thirteen, Elara had already erased the street twice.</p>' +
  '<p>It was a small street. An unremarkable street. The sort of narrow, rain-dark passage that a person could walk down every morning for forty years without ever thinking to learn its name. But it had been there yesterday, between the apothecary and the house with the blue door. She was certain of that.</p>' +
  '<p>Her father’s map said otherwise.</p>' +
  '<p>She leaned closer to the desk, letting the amber light of the lamp settle over the paper. His ink had faded to the colour of old tea, but the lines were as precise as ever. Every alley. Every courtyard. Every place the city had allowed itself to remember.</p>' +
  '<p>“You can’t erase a place,” she said to the empty shop. “Not without leaving something behind.”</p>'
const longBook = new URLSearchParams(location.search).has('long')
const sceneIds = longBook ? ['first', 'second', 'third', ...Array.from({ length: 37 }, (_, index) => 'scene-' + index)] : ['first', 'second', 'third']
const refs = sceneIds.map((id, index) => ({ ...context, chapterGuid: index < 2 ? 'chapter-1' : 'chapter-2', sceneId: id }))
const chapters = [{ guid: 'chapter-1', act: 'Part one', title: 'The city that forgot', description: 'A missing street. An impossible map. The first sign that the city is keeping a secret.', order: 0 },
  { guid: 'chapter-2', title: 'Beneath the ink', description: 'Some secrets refuse to stay on the page.', order: 1 }].map(chapter => ({ ...chapter,
    scenes: refs.filter(ref => ref.chapterGuid === chapter.guid).map(ref => ({ id: ref.sceneId, title: 'Hidden scene title', wordCount: 181, stage: 'revised', synopsis: '' })) }))
const registry = new WritingDocumentRegistry({ context, isCurrent: () => true, transport: {
  read: async ref => ({ html: longBook ? prose.repeat(1 + sceneIds.indexOf(ref.sceneId) % 4) : prose, hash: 'saved' }), activate: async () => true,
  commit: async () => { throw Error('This appearance fixture cannot save a project'); }
} })
const i18n = createInstance()
window.commands = []; window.structures = []; window.metadataWrites = []
window.addEventListener('novalist:writing-structure', event => window.structures.push(event.detail))
window.changeLanguage = language => i18n.changeLanguage(language)
window.updateAppearanceSettings = patch => {
  useSettingsStore.setState(state => ({ view: { effective: { ...state.view.effective, ...patch } } }))
  const live = model.getState().live
  if (live) pushWritingTypography(live, useSettingsStore.getState().view.effective)
}
window.useSharedSynopsis = () => useProjectStore.setState(state => ({ chapters: state.chapters.map(chapter => ({ ...chapter,
  scenes: chapter.scenes.map(scene => scene.id === 'first' ? { ...scene, sharedProse: { sessionId: 'shared', fields: { synopsis: 'summary' } } } : scene) })) }))
window.setBookLayout = (enabled, inches = 4) => {
  const live = model.getState().live
  useSettingsStore.setState(state => ({ view: { effective: { ...state.view.effective, enableBookWidth: enabled, bookPageFormat: 'Custom', bookTextBlockWidth: inches } } }))
  pushWritingTypography(live, useSettingsStore.getState().view.effective)
}
window.connectEditor = live => {
  const state = model.getState()
  live.setWritingContext(context, 'appearance')
  live.setWritingProjection(state.snapshots, null)
  const tokens = getComputedStyle(document.documentElement)
  live.setTheme(tokens.getPropertyValue('--nl-surface-editor'), tokens.getPropertyValue('--nl-text'),
    tokens.getPropertyValue('--nl-accent'), tokens.getPropertyValue('--nl-surface-selected'),
    tokens.getPropertyValue('--nl-surface-card'), tokens.getPropertyValue('--nl-text'))
  pushWritingTypography(live, useSettingsStore.getState().view.effective)
  useWritingZoomStore.subscribe(state => live.setWritingZoom(state.percent / 100))
  live.setReadingComfort(1.95, 0, .8, 0)
  live.setBookParagraphSpacing(true)
  model.setState({ live, projectionRevision: 1 })
}
async function mount() {
  const snapshots = await Promise.all(refs.map(ref => registry.read(ref)))
  useProjectStore.setState({ chapters, projectPath: '/appearance', activeBookId: 'book', activeDraftId: 'draft', workspaceEpoch: 1,
    renameScene: async (...args) => window.metadataWrites.push(['scene', ...args]),
    renameChapter: async (...args) => window.metadataWrites.push(['chapter', ...args]),
    books: [{ id: 'book', name: 'The Cartographer’s Silence' }], drafts: [{ id: 'draft', name: 'First draft' }] })
  const adapter = { requestStructure: command => window.structures.push(command) }
  model.setState({ live: null, registry, snapshots, chapters, refs, scope: 'manuscript', anchor: refs[0], projectionRevision: 0,
    selectedSceneIds: null, selection: { focus: refs[0] }, loading: false, error: null, adapter,
    setScope(scope, focus) {
      const state = model.getState(), anchor = focus ?? state.anchor,
        visible = scope === 'scene' ? snapshots.filter(scene => scene.sceneId === anchor.sceneId) :
          scope === 'chapter' ? snapshots.filter(scene => scene.chapterGuid === anchor.chapterGuid) : snapshots
      state.live.setWritingProjection(visible, null)
      model.setState({ scope, anchor, snapshots: visible, refs: visible, projectionRevision: state.projectionRevision + 1 })
    } })
  await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, de: { translation: de } } })
  createRoot(document.getElementById('root')).render(<I18nextProvider i18n={i18n}><UnifiedWritingEditor paneId="appearance" /></I18nextProvider>)
}
mount()
`

export async function buildWritingAppearance(): Promise<string> {
  const directory = resolve('out/writing-appearance')
  await mkdir(directory, { recursive: true })
  await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, outfile: resolve(directory, 'fixture.js'), platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'text' }, logLevel: 'silent',
    plugins: [{ name: 'appearance-host', setup(builder) {
      builder.onResolve({ filter: /./ }, args => {
        if (!args.path.startsWith('.')) return
        const key = args.path.split('/').at(-1)!
        if (key in sources) return { path: key, namespace: 'fixture' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: process.cwd(), loader: 'tsx' }))
    } }] })
  const css = `<link rel="stylesheet" href="${pathToFileURL(resolve('src/renderer/public/fonts/fonts.css')).href}">` +
    ['styles/tokens.css', 'styles/base.css', 'shell/shell.css', 'views/editor/editor.css', 'views/editor/unified-writing.css']
    .map(path => `<link rel="stylesheet" href="${pathToFileURL(resolve('src/renderer/src', path)).href}">`).join('\n')
  await writeFile(resolve(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${css}</head>
    <body><div id="root"></div><script>window.editorUrl=${JSON.stringify(pathToFileURL(resolve('src/renderer/public/editor/editor.html')).href)};</script>
    <script src="fixture.js"></script></body></html>`)
  return pathToFileURL(resolve(directory, 'index.html')).href
}
