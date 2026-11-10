import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sources: Record<string, string> = {
  projectStore: `import { create } from 'zustand'; export const useProjectStore = create(() => ({})); export const editorPane = (state, id) => state.editors[id];`,
  shellStore: `import { create } from 'zustand'; export const findPane = panes => panes;
    export const useShellStore = create(set => ({ panes: { kind: 'leaf', writingScope: 'manuscript' },
      setPaneWritingScope: (id, writingScope) => set({ panes: { kind: 'leaf', writingScope } }), setActivePane() {} }));`,
  filterStore: `import { create } from 'zustand'; export const useFilterStore = create(() => ({ filter: {} }));`,
  manuscriptStore: `import { create } from 'zustand'; export const useManuscriptStore = create(() => ({ composed: null }));`,
  writingPersistence: `export const observeWritingPersistence = () => () => {};`,
  useWritingEntityNames: `const value = { names: {}, error: null }; export const useWritingEntityNames = () => value;`,
  sharedWritingSessions: `export const findSharedWritingSession = () => undefined; export const getSharedWritingSession = () => { throw Error('No shared prose'); }; export const createSharedWritingBinding = getSharedWritingSession;`,
  SharedWritingHistory: `export class SharedWritingHistory {}`,
  WritingSharedPresence: `export class WritingSharedPresence { update() {} close() {} }`,
  sharedWritingAnnotations: `export const getSharedWritingAnnotations = () => ({ observe: () => () => {} }); export const refreshSharedWritingAnnotations = async () => {};`,
  sharedProjectNotifications: `export const useSharedProjectRevision = { subscribe: () => () => {}, getState: () => 0 };`,
  writingEditingClaims: `export const writingEditingClaims = { focus() {}, blur() {} };`,
  writingAnnotationMessages: `export const handleWritingAnnotationMessage = () => false; export const pushWritingAnnotations = () => {}; export const applyWritingAnnotations = () => {};`,
  writingHistory: `export const acceptWritingTransaction = (registry, transaction) => registry.apply(transaction); export const acceptSharedWritingTransaction = () => {}; export const getWritingHistory = () => {};`,
  client: `export const rpc = { request: async () => { throw Error('Synthetic fixture cannot access a project'); } };`
}

export async function buildWritingScopePosition(): Promise<string> {
  const directory = resolve('out/writing-scope-position')
  await mkdir(directory, { recursive: true })
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { useUnifiedWritingDocument } from './src/renderer/src/views/editor/useUnifiedWritingDocument'
    import { WritingDocumentRegistry } from './src/renderer/src/stores/writingDocuments'
    import { useProjectStore } from './src/renderer/src/stores/projectStore'
    import canvasCss from './src/renderer/src/views/editor/writing-canvas.css'
    const context = { workspaceId: '/synthetic', workspaceEpoch: 1, bookId: 'book', draftId: 'draft' }
    const ids = ['first', 'second', 'third', 'fourth']
    const chapters = ['chapter-one', 'chapter-two'].map((guid, order) => ({ guid, order, title: guid,
      scenes: ids.slice(order * 2, order * 2 + 2).map((id, order) => ({ id, order, stage: '', plotlineIds: [] })) }))
    const registry = new WritingDocumentRegistry({ context, isCurrent: () => true, transport: {
      read: async ref => ({ html: Array.from({ length: 24 }, (_, index) => '<p>' + ref.sceneId + ' paragraph ' + index +
        '. Die Reise durch die nächtliche Stadt führte an alten Häusern und verborgenen Gärten vorbei. '.repeat(3) + '</p>').join(''), hash: ref.sceneId }),
      commit: async () => { throw Error('Synthetic fixture cannot write a project'); }
    } })
    useProjectStore.setState({ projectPath: '/synthetic', workspaceEpoch: 1, activeBookId: 'book', activeDraftId: 'draft', chapters,
      editors: { pane: { chapterGuid: 'chapter-one', sceneId: 'first' } }, getWritingRegistry: () => registry, setContextScene() {} })
    function Probe() {
      const model = useUnifiedWritingDocument('pane', () => {})
      window.scopeModel = model
      return <><nav>{['scene', 'chapter', 'manuscript'].map(scope => <button key={scope} onClick={() => model.setScope(scope)}>{scope}</button>)}</nav>
        <iframe title="writing" src={window.editorUrl} onLoad={event => {
          const live = event.currentTarget.contentWindow
          const style = live.document.createElement('style'); style.textContent = canvasCss; live.document.head.append(style)
          const tokens = getComputedStyle(document.documentElement)
          for (const property of tokens) if (property.startsWith('--nl-')) live.document.documentElement.style.setProperty(property, tokens.getPropertyValue(property))
          live.document.body.classList.add('unified-writing-canvas')
          live.sendMessage = message => window.scopeModel.adapter.message(message)
          live.setFont('Georgia', 17)
          live.setReadingComfort(1.7, 0, .75, 0)
          model.adapter.ready(live)
        }} />
        {model.error && <output role="alert">{model.error}</output>}</>
    }
    createRoot(document.getElementById('root')).render(<Probe />)
  ` }, bundle: true, outfile: resolve(directory, 'fixture.js'), platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'text' }, logLevel: 'silent',
    plugins: [{ name: 'scope-fixture', setup(builder) {
      builder.onResolve({ filter: /./ }, args => {
        if (args.path === 'react-dom/client') return
        const key = args.path.split('/').at(-1)!
        if (key in sources) return { path: key, namespace: 'fixture' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: sources[args.path], resolveDir: process.cwd() }))
    } }] })
  await writeFile(resolve(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
    <link rel="stylesheet" href="${pathToFileURL(resolve('src/renderer/src/styles/tokens.css')).href}">
    <style>body { margin: 0 } nav { height: 40px } iframe { display: block; border: 0; width: 100%; height: calc(100vh - 40px) }</style></head>
    <body><div id="root"></div><script>window.novalist={isMobile:false};window.editorUrl=${JSON.stringify(pathToFileURL(resolve('src/renderer/public/editor/editor.html')).href)};</script><script src="fixture.js"></script></body></html>`)
  return pathToFileURL(resolve(directory, 'index.html')).href
}
