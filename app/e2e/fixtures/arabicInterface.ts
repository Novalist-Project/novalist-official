import { build, type PluginBuild } from 'esbuild'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = String.raw`
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import i18n from './src/renderer/src/i18n'
import { MainArea } from './src/renderer/src/shell/MainArea'
import { PanelResizer } from './src/renderer/src/shell/PanelResizer'
import { FocusMode } from './src/renderer/src/shell/FocusMode'
import { appearanceSettingsBody } from './src/renderer/src/views/settings/appearanceSettingsBody'
import { useShellStore } from 'fixture-shell'
window.novalist = { isMobile: false }
function Fixture() {
  const { t } = useTranslation()
  const [binderWidth, setBinderWidth] = useState(220)
  const [inspectorWidth, setInspectorWidth] = useState(220)
  const focusing = useShellStore(state => state.focusMode)
  return <div className={'shell' + (focusing ? ' shell-focus' : '')}>
    <div className="fixture-settings">{appearanceSettingsBody({ t, scopeToggle: () => null,
      eff: { language: i18n.language, theme: 'Default' }, themes: [], scopeFor: () => 'global',
      update: (_, patch) => i18n.changeLanguage(patch.language), uiScale: 100, setUiScale() {}, resetUiScale() {}, assetDirs: null })}</div>
    <button onClick={() => useShellStore.setState({ placingNotes: true })}>Place notes</button>
    <button onClick={() => useShellStore.setState({ focusMode: true, mainView: 'write' })}>Enter Focus mode</button>
    {focusing ? <><iframe className="editor-frame" title="Synthetic manuscript" /><FocusMode /></> : <div className="shell-body">
      <aside className="binder" style={{ width: binderWidth }}>Navigation
        <PanelResizer edge="right" width={binderWidth} onResize={setBinderWidth} /></aside>
      <div className="shell-main"><MainArea /></div>
      <aside className="inspector" style={{ width: inspectorWidth }}>Inspector
        <PanelResizer edge="left" width={inspectorWidth} onResize={setInspectorWidth} /></aside>
    </div>}
  </div>
}
createRoot(document.getElementById('root')).render(<Fixture />)
`

const store = String.raw`
import { create } from 'zustand'
import { paneLeaves, findPane, dockNotesPane, resize } from './src/renderer/src/stores/shellPanes'
export { paneLeaves, findPane }
export const useShellStore = create(set => ({
  panes: { kind: 'split', id: 'split', direction: 'row', sizes: [50, 50], children: [
    { kind: 'leaf', id: 'first', view: 'dashboard' }, { kind: 'leaf', id: 'second', view: 'about' }] },
  activePaneId: 'first', notesDockVisible: true, placingNotes: false, setActivePane: activePaneId => set({ activePaneId }),
  focusMode: false, focusPanel: null, focusPanelTransient: false, focusToolsVisible: false,
  revealFocusPanel: focusPanel => set({ focusPanel, focusPanelTransient: true }),
  closeFocusPanel: () => set({ focusPanel: null }), setFocusToolsVisible: focusToolsVisible => set({ focusToolsVisible }),
  setPaneSizes: (id, sizes) => set(state => ({ panes: resize(state.panes, id, sizes) }))
}))
export const dock = (id, edge) => useShellStore.setState(state => ({ panes: dockNotesPane(state.panes, id, edge), placingNotes: false }))
`

function localeLoader(builder: PluginBuild, locales: string[]): void {
  builder.onLoad({ filter: /i18n[\\/]index\.ts$/ }, async args => {
    const source = await readFile(args.path, 'utf8')
    const imports = locales.map((file, index) => `import locale${index} from '../locales/${file}';`).join('\n')
    const modules = locales.map((file, index) => `'../locales/${file}': { default: locale${index} }`).join(',')
    return { contents: imports + '\n' + source.replace(/import\.meta\.glob[\s\S]*?\n\)/, `{ ${modules} }`), loader: 'ts' }
  })
}

const detailsEntry = String.raw`
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ArrowLeft, ArrowRight, ChevronDown, ChevronRight, CornerDownRight } from 'lucide-react'
import i18n from './src/renderer/src/i18n'
window.setLanguage = language => i18n.changeLanguage(language)
const mark = 'icon-directional'
function Details() {
  return <div className="project-library">
    <section id="icons" className="fixture-icons">
      <button className="settings-back"><ArrowLeft id="settings-back" size={16} className={mark} />Settings</button>
      <button className="open-book"><span>Open book</span><ArrowRight id="open-book" size={17} className={mark} /></button>
      <button className="ctx-section-head" aria-expanded="false"><ChevronRight id="ctx-collapsed" className={mark + ' ctx-section-chevron'} size={12} /><span>Collapsed</span></button>
      <button className="ctx-section-head" aria-expanded="true"><ChevronDown id="ctx-open" className="ctx-section-chevron" size={12} /><span>Open</span></button>
      <ChevronRight id="binder-closed" size={13} className={mark + ' binder-chevron'} />
      <ChevronRight id="binder-open" size={13} className={mark + ' binder-chevron open'} />
      <CornerDownRight id="reply" size={11} className={mark} />
      <ArrowLeft id="plain" size={16} />
    </section>
    <section id="recent" className="dashboard-card dashboard-recent">
      <button className="dashboard-activity-row dashboard-activity-link">
        <div className="dashboard-activity-main"><div className="dashboard-activity-scene">خروج الأمر عن السيطرة وما بعده</div><div className="dashboard-activity-chapter">مشروع جلمود</div></div>
        <div className="dashboard-activity-time">11:09</div>
      </button>
    </section>
    <section id="wiki" className="wiki-index">
      <ul className="wiki-entry-list"><li><button className="wiki-entry"><span className="wiki-entry-thumb wiki-entry-thumb-empty" />
        <span className="wiki-entry-text"><span className="wiki-entry-title">ألكسندر إلياس الطويل جدا</span><span className="wiki-entry-subtitle">الأمن والسلطة العسكرية</span></span></button></li></ul>
    </section>
    <section id="scenes" className="binder">
      <button className="binder-scene-row"><span className="binder-scene-title">حين سبقت الطموحات الاحتياطات كلها</span><span className="binder-scene-words">412</span></button>
    </section>
    <section id="shelf" className="library-book" style={{ '--shelf-row-height': '260px', '--library-cover-w': '140px', '--library-cover-h': '200px' }}>
      <button className="start-recent-card" aria-pressed="false" aria-label="Book"><div className="start-recent-cover volume-cover"><div className="volume-cover-front" /></div></button>
    </section>
  </div>
}
createRoot(document.getElementById('root')).render(<Details />)
`

export async function buildArabicDetails(): Promise<string> {
  const directory = resolve('out/arabic-details')
  await mkdir(directory, { recursive: true })
  const locales = (await readdir(resolve('src/renderer/src/locales'))).filter(file => file.endsWith('.json'))
  await build({ stdin: { contents: detailsEntry, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true,
    outfile: resolve(directory, 'details.js'), platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty' }, logLevel: 'silent',
    plugins: [{ name: 'locales', setup: builder => localeLoader(builder, locales) }] })
  const css = ['styles/tokens.css', 'styles/base.css', 'shell/shell.css', 'styles/desktop.css', 'shell/inspector.css', 'shell/bookshelf.css',
    'views/dashboard/dashboard.css', 'views/wiki/wiki.css', 'styles/rtl.css']
    .map(path => `<link rel="stylesheet" href="${pathToFileURL(resolve('src/renderer/src', path)).href}">`).join('')
  await writeFile(resolve(directory, 'index.html'), `<!doctype html><html data-shell="desktop"><head><meta charset="utf-8">${css}
    <style>body{padding:var(--nl-space-xl)}#recent,#wiki,#scenes{width:260px;position:static}.library-book{width:220px}.fixture-icons{display:flex;flex-direction:column;align-items:flex-start}</style>
    </head><body><div id="root"></div><script src="details.js"></script></body></html>`)
  return pathToFileURL(resolve(directory, 'index.html')).href
}

export async function buildArabicInterface(): Promise<string> {
  const directory = resolve('out/arabic-interface')
  await mkdir(directory, { recursive: true })
  const mainArea = await readFile(resolve('src/renderer/src/shell/MainArea.tsx'), 'utf8')
  const stubs = new Map<string, string>()
  for (const match of mainArea.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    if (!match[2].startsWith('.') || match[2] === './NotesDockTargets') continue
    const names = match[1].split(',').map(name => name.trim()).filter(name => !name.startsWith('type '))
    stubs.set(match[2], names.map(name => `export const ${name} = () => null;`).join('\n'))
  }
  stubs.set('../stores/shellStore', "export * from 'fixture-shell'")
  stubs.set('../stores/projectStore', 'export const editorPane = () => ({ sceneId: null }); export const useProjectStore = select => select({ chapters: [] });')
  stubs.set('../stores/extensionsStore', 'export const useExtensionsStore = select => select({ views: [] });')
  stubs.set('./DesktopViewFrame', 'export const DesktopViewFrame = ({ children }) => children;')
  stubs.set('../stores/editorBridgeStore', 'export const useEditorBridge = { getState: () => ({ editor: null }) };')
  stubs.set('./commands', 'export const runCommand = () => {};')
  stubs.set('./Binder', "import React from 'react'; export const Binder = () => React.createElement('div', { className: 'binder' }, 'Navigation');")
  stubs.set('./Inspector', `import React, { useEffect } from 'react';
    export const Inspector = ({ onReadyChange }) => { useEffect(() => onReadyChange(true), [onReadyChange]);
      return React.createElement('div', { className: 'inspector' }, 'Inspector'); };`)
  stubs.set('./sceneNotesDocking', `import { useShellStore, dock } from 'fixture-shell';
    export const useNotesDocking = select => { const placing = useShellStore(s => s.placingNotes);
      const state = { state: { docked: true }, released: false, placing, transferring: false };
      return select ? select(state) : state; };
    useNotesDocking.setState = () => useShellStore.setState({ placingNotes: false });
    export const dockSceneNotesAt = async (id, edge) => dock(id, edge);`)
  const locales = (await readdir(resolve('src/renderer/src/locales'))).filter(file => file.endsWith('.json'))
  await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true,
    outfile: resolve(directory, 'fixture.js'), platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty' }, logLevel: 'silent',
    plugins: [{ name: 'interface-host', setup(builder) {
      builder.onResolve({ filter: /^fixture-shell$/ }, () => ({ path: 'store', namespace: 'fixture' }))
      builder.onResolve({ filter: /^\./ }, args => {
        const main = /\/shell\/(MainArea|FocusMode)\.tsx$/.test(args.importer.replaceAll('\\', '/'))
        const docking = args.path === './sceneNotesDocking' && args.importer.endsWith('NotesDockTargets.tsx')
        return (main || docking) && stubs.has(args.path) ? { path: args.path, namespace: 'stub' } : undefined
      })
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs.get(args.path)!, loader: 'js', resolveDir: process.cwd() }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: store, loader: 'js', resolveDir: process.cwd() }))
      localeLoader(builder, locales)
    } }] })
  const css = ['styles/tokens.css', 'styles/base.css', 'shell/shell.css', 'styles/desktop.css', 'shell/sceneChecklist.css', 'shell/focus-mode.css', 'styles/rtl.css']
    .map(path => `<link rel="stylesheet" href="${pathToFileURL(resolve('src/renderer/src', path)).href}">`).join('')
  await writeFile(resolve(directory, 'index.html'), `<!doctype html><html data-shell="desktop"><head><meta charset="utf-8">${css}
    <style>.fixture-settings{height:180px;overflow:auto}.shell-body{min-height:400px}.binder,.inspector{position:relative;flex-shrink:0}.pane-leaf{min-width:0}
    .shell-focus .editor-frame{position:absolute;left:160px;right:320px;top:260px;width:calc(100% - 480px);height:600px;max-width:none;margin:0}</style>
    </head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
  return pathToFileURL(resolve(directory, 'index.html')).href
}
