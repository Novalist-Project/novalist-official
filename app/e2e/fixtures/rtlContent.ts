import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = String.raw`
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { MetadataInput } from './src/renderer/src/collaboration/MetadataInput'
import { EntityDetailFields } from './src/renderer/src/views/codex/EntityDetailFields'
import { MarkdownEditor } from './src/renderer/src/shell/MarkdownEditor'
import { WikiArticle } from './src/renderer/src/views/wiki/WikiArticle'
import en from './src/renderer/src/locales/en.json'
const article = { id: 'arabic', typeKey: 'character', title: 'ليلى', aliases: [], lead: {},
 description: 'كانت ليلى تقرأ في المدينة.', infobox: { images: [], fields: [{ literalLabel: 'Name', value: 'ليلى' }] },
 sections: [{ title: 'حكاية', content: globalThis.rtlWikiContent ?? 'مرحبا بالعالم 123.\n\nEnglish paragraph.\n\n> اقتباس عربي\n\n- عنصر عربي\n\n' + String.fromCharCode(96) + 'code 123' + String.fromCharCode(96) }],
 relationships: [], referencedBy: [], contains: [], appearsWith: [], plotlines: [], mapPins: [], research: [], events: [], overrides: [], appearances: [] }
function Fixture() {
 const [name, setName] = useState('ليلى')
 const [record, setRecord] = useState({ id: 'custom', name: 'ليلى', fields: { language: 'English' } })
 const [markdown, setMarkdown] = useState('مرحبا بالعالم\nEnglish paragraph')
 const [wikiContent, setWikiContent] = useState(article.sections[0].content)
 return <><header>English interface</header>
 <MetadataInput aria-label="Scene name" value={name} editable change={setName} format={value => value} parse={value => value} />
 <EntityDetailFields entityType="custom" record={record} customDef={{ defaultFields: [{ key: 'language', displayName: 'Language', type: 'Enum', enumOptions: ['English', 'العربية'] }] }}
 updateField={async (key, value) => setRecord(previous => ({ ...previous, fields: { ...previous.fields, [key]: value } }))} />
 <MarkdownEditor ariaLabel="Mixed Markdown" value={markdown} onChange={setMarkdown} />
 <button onClick={() => setWikiContent('- English item\n\n  More English\n\n> English quotation')}>English Wiki content</button>
 <WikiArticle article={{ ...article, sections: [{ ...article.sections[0], content: wikiContent }] }} /></>
}
const i18n = createInstance()
i18n.init({ lng: 'en', resources: { en: { translation: en } } }).then(() =>
 createRoot(document.getElementById('root')).render(<I18nextProvider i18n={i18n}><Fixture /></I18nextProvider>))
`

export async function buildRtlContent(): Promise<string> {
  const directory = resolve('out/rtl-content')
  await mkdir(directory, { recursive: true })
  await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true,
    outfile: resolve(directory, 'fixture.js'), platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.css': 'empty' }, logLevel: 'silent',
    plugins: [{ name: 'rtl-host', setup(builder) {
      builder.onResolve({ filter: /^\..*\/(client|wikiStore|codexStore|shellStore|projectStore|hostBridgeStore|sharedMarkdown|SharedEditorPresence|useEntityFieldSuggestions)$/ }, args => ({ path: args.path.split('/').at(-1)!, namespace: 'host' }))
      builder.onLoad({ filter: /.*/, namespace: 'host' }, args => {
        const source: Record<string, string> = {
          client: "export const rpc = { request: async () => ({ hidden: [], order: [] }) }",
          wikiStore: "export const useWikiStore = selector => selector({ openArticle() {}, regenerate() {}, regenerating: false });",
          codexStore: "export const useCodexStore = { getState: () => ({}) };",
          shellStore: "export const useShellStore = selector => selector({ navigateToMapPin() {} });",
          projectStore: "export const useProjectStore = selector => selector({ chapters: [] });",
          hostBridgeStore: "export const useHostBridgeStore = { getState: () => ({ pushToast() {} }) };",
          sharedMarkdown: "export const proseBinding = () => undefined; export const openSharedMarkdown = () => { throw Error('Unexpected shared session'); };",
          SharedEditorPresence: "export class SharedEditorPresence {}",
          useEntityFieldSuggestions: "export const useEntityFieldSuggestions = () => ({ names: {}, errors: {}, load() {} });"
        }
        return { contents: source[args.path], loader: 'js' }
      })
    } }] })
  const css = ['styles/tokens.css', 'styles/base.css', 'shell/markdownEditor.css', 'views/wiki/wiki.css']
    .map(path => `<link rel="stylesheet" href="${pathToFileURL(resolve('src/renderer/src', path)).href}">`).join('')
  await writeFile(resolve(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${css}<style>body{overflow:auto}#root{padding:20px}.md-editor{height:180px}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
  return pathToFileURL(resolve(directory, 'index.html')).href
}
