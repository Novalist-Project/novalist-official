import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { launchWriting } from './fixtures/writingHarness'
import { writingProvenance } from './fixtures/writingProvenance'
import { writingDiagnosticEvidence } from './fixtures/writingDiagnosticEvidence.mts'
import './fixtures/writingSceneText'

const fixtures = [
  { name: 'blocks', html: '<p>alpha</p><p>bravo<br>charlie</p>tail' },
  { name: 'inline', html: 'lead <em>middle</em> tail<br>end' },
  { name: 'authored-display', html: '<p style="display:inline">alpha</p><p style="display:inline">bravo</p><p style="display:table-row !important;margin:1em 0!important">charlie</p>delta' },
  { name: 'authored-hidden', html: '<p>alpha <span hidden>secret</span><span style="visibility:hidden">hidden <b style="visibility:visible">visible</b></span></p><p style="display:none">omitted</p><p>bravo</p>' },
  { name: 'normal-whitespace', html: '<span style="white-space:normal"> alpha  <em>beta </em></span> gamma <span style="text-transform:uppercase">delta</span>' },
  { name: 'nested', html: '<ul><li>alpha</li><li>bravo</li></ul><table><tbody><tr><td>charlie</td><td>delta</td></tr><tr><td>echo</td><td>foxtrot</td></tr></tbody></table><figure><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="image"><figcaption>golf</figcaption></figure>' },
  { name: 'empty', html: '<p><br></p>' },
  { name: 'inline-block', html: '<div style="display:inline-block">alpha<br>beta</div> tail <span style="display:block">gamma</span>' },
  { name: 'authored-inline-paragraphs', html: '<p style="display:inline">alpha</p><p style="display:inline">bravo</p>' },
  { name: 'pre-line-block-edge', html: '<div style="white-space:pre-line">  alpha  \n  bravo  </div><p>charlie</p>' },
  { name: 'pre-line-inline', html: '<div style="white-space:pre-line"> alpha <em>  bravo </em>  charlie \n <strong> delta </strong> echo </div>' },
  { name: 'invalid-language-uppercase', html: '<p lang="en_US" style="text-transform:uppercase">alpha i</p><p>tail</p>' },
  { name: 'inherited-language-uppercase', html: '<p lang="tr" style="text-transform:uppercase"><em>iki</em></p><p>tail</p>' }
]

for (const fixture of fixtures) {
  test(`logical publication text matches rendered scene independently of fragment and scope: ${fixture.name}`, async ({}, info) => {
    const h = await launchWriting('experiment', 1, false)
    try {
      await h.seed({ wordCount: 8, scenes: [{ id: 'owner', html: fixture.html }] })
      const bundle = await build({ stdin: { contents: "import { logicalSceneText } from './e2e/fixtures/writingSceneText'; window.writingLogicalSceneText = logicalSceneText;", resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser' })
      const frame = h.frames()[0]
      await frame.addScriptTag({ content: bundle.outputFiles[0].text })
      const result = await frame.evaluate(() => {
        const scene = document.querySelector<HTMLElement>('[data-scene-id]')!
        const atoms = Array.from(scene.childNodes)
        const baseline = { text: scene.innerText, error: null }
        const extract = () => {
          try { return { text: window.writingLogicalSceneText(atoms), error: null } }
          catch (error) { return { text: null, error: error instanceof Error ? error.name : typeof error } }
        }
        const initial = extract()
        const second = document.createElement('section')
        scene.parentNode!.appendChild(second)
        atoms.slice(Math.max(1, Math.floor(atoms.length / 2))).forEach(node => second.appendChild(node))
        const fragmented = extract()
        const hidden = document.createElement('div')
        hidden.hidden = true
        scene.parentNode!.appendChild(hidden)
        hidden.append(scene, second)
        const scoped = extract()
        return { baseline, initial, fragmented, scoped, connected: atoms.every(node => node.isConnected), sceneHidden: getComputedStyle(hidden).display === 'none' }
      })
      await writeFile(info.outputPath('surface-plain-text.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(),
        workload: { route: 'experiment', logicalTextOnly: true, panes: 1, scenes: 1, fixture: fixture.name }, result }), null, 2))
      expect(result.connected && result.sceneHidden).toBe(true)
      expect(result.initial).toEqual(result.baseline)
      expect(result.fragmented).toEqual(result.baseline)
      expect(result.scoped).toEqual(result.baseline)
    } finally { await h.close() }
  })
}
