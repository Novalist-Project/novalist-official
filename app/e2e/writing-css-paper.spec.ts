import { expect, test, type Frame } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { launchWriting } from './fixtures/writingHarness'
import { writingProvenance } from './fixtures/writingProvenance'
import { writingDiagnosticEvidence } from './fixtures/writingDiagnosticEvidence.mts'

async function nativeState(frame: Frame) {
  return frame.evaluate(() => {
    const root = document.getElementById('editor')!
    const selection = window.getSelection()!
    const paragraphs = Array.from(root.querySelectorAll('p'))
    return { html: root.innerHTML, text: root.textContent, paragraphs: paragraphs.length,
      anchorParagraph: paragraphs.findIndex(p => p.contains(selection.anchorNode)), anchorOffset: selection.anchorOffset,
      focusParagraph: paragraphs.findIndex(p => p.contains(selection.focusNode)), focusOffset: selection.focusOffset,
      collapsed: selection.isCollapsed }
  })
}

for (const spacing of ['none', 'before', 'after', 'pseudo-before', 'pseudo-after']) {
  for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight']) {
    test(`CSS paper native proof: ${spacing} ${key}`, async ({}, info) => {
      const h = await launchWriting('original', 1, false)
      try {
        await h.seed({ wordCount: 2, scenes: [{ id: 'css-owner', html: '<p>alpha</p><p>bravo</p>' }] })
        const frame = h.frames()[0]
        const before = await frame.evaluate(({ spacing, key }) => {
          const root = document.getElementById('editor')!
          const paragraphs = root.querySelectorAll('p')
          const sheet = new CSSStyleSheet()
          const rules: Record<string, string> = {
            none: '', before: '#editor > p:nth-child(2) { margin-top: 8em; }',
            after: '#editor > p:first-child { margin-bottom: 8em; }',
            'pseudo-before': '#editor > p:nth-child(2)::before { content:"";display:block;height:8em;pointer-events:none;user-select:none; }',
            'pseudo-after': '#editor > p:first-child::after { content:"";display:block;height:8em;pointer-events:none;user-select:none; }'
          }
          sheet.replaceSync(rules[spacing])
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
          root.focus({ preventScroll: true })
          const backwards = key === 'Backspace' || key === 'ArrowLeft'
          const node = paragraphs[backwards ? 1 : 0].firstChild!
          window.getSelection()!.setBaseAndExtent(node, backwards ? 0 : 5, node, backwards ? 0 : 5)
          const rects = Array.from(paragraphs, paragraph => {
            const range = document.createRange()
            range.selectNodeContents(paragraph)
            return { text: range.getBoundingClientRect().toJSON(), block: paragraph.getBoundingClientRect().toJSON() }
          })
          return { html: root.innerHTML, distance: paragraphs[1].getBoundingClientRect().top - paragraphs[0].getBoundingClientRect().bottom, rects,
            em: parseFloat(getComputedStyle(root).fontSize) }
        }, { spacing, key })
        expect(before.html).toBe('<p>alpha</p><p>bravo</p>')
        expect(before.distance).toBeCloseTo(spacing === 'before' || spacing === 'after' ? 8 * before.em : 0)
        await h.page.keyboard.press(key)
        const first = await nativeState(frame)
        await h.page.keyboard.press(key)
        const second = await nativeState(frame)
        await writeFile(info.outputPath('css-native.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(),
          workload: { route: 'original', appliedAdaptations: false, scenes: 1, words: 2, panes: 1 }, spacing, key, before, first, second }), null, 2))
        expect(first.text).toBe('alphabravo')
        expect(first.collapsed).toBe(true)
        if (key === 'Backspace' || key === 'Delete') {
          expect(first.html).toBe('<p>alphabravo</p>')
          expect(first.anchorParagraph).toBe(0)
          expect(first.anchorOffset).toBe(5)
          expect(second.text).toBe(key === 'Backspace' ? 'alphbravo' : 'alpharavo')
        } else {
          expect(first.html).toBe(before.html)
          expect(first.anchorParagraph).toBe(key === 'ArrowLeft' ? 0 : 1)
          expect(first.anchorOffset).toBe(key === 'ArrowLeft' ? 5 : 0)
          expect(second.anchorOffset).toBe(key === 'ArrowLeft' ? 4 : 1)
        }
      } finally { await h.close() }
    })
  }
}

for (const containment of [false, true]) {
  test(`CSS paper raw-text proof: containment ${containment}`, async ({}, info) => {
    const h = await launchWriting('original', 1, false)
    try {
      await h.seed({ wordCount: 7, scenes: [{ id: 'css-owner', html: 'leading <em>inline</em><p style="margin:1em 0;padding:0.5em">block</p>trailing <strong>inline</strong><p>end</p>tail' }] })
      const result = await h.frames()[0].evaluate(containment => {
        const root = document.getElementById('editor')!
        const nodes = Array.from(root.childNodes)
        const html = root.innerHTML
        const sheet = new CSSStyleSheet()
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
        const measure = () => nodes.map(node => {
          const range = document.createRange()
          range.selectNode(node)
          return Array.from(range.getClientRects(), rect => ({ top: rect.top, bottom: rect.bottom, height: rect.height }))
        })
        const before = measure()
        const em = parseFloat(getComputedStyle(root).fontSize)
        sheet.replaceSync(`#editor { ${containment ? 'content-visibility:auto;contain-intrinsic-size:auto 600px;' : ''} padding-top:calc(var(--padding-v) + 8em); }
          #editor > p:first-of-type { margin-bottom:9em !important; }`)
        const after = measure()
        return { html, unchangedHtml: root.innerHTML === html, connected: nodes.every((node, index) => node.isConnected && root.childNodes[index] === node), em, before, after }
      }, containment)
      await writeFile(info.outputPath('css-raw.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(),
        workload: { route: 'original', appliedAdaptations: false, panes: 1, scenes: 1, words: 7 }, containment, result }), null, 2))
      expect(result.unchangedHtml).toBe(true)
      expect(result.connected).toBe(true)
      expect(result.after[0][0].top - result.before[0][0].top).toBeCloseTo(8 * result.em)
      expect(result.after[3][0].top - result.before[3][0].top).toBeCloseTo(16 * result.em)
      expect(result.after[6][0].top - result.before[6][0].top).toBeCloseTo(16 * result.em)
    } finally { await h.close() }
  })
}

for (const spacing of ['margin', 'pseudo']) {
  for (const important of [false, true]) {
    test(`CSS paper authored spacing: ${spacing} important ${important}`, async ({}, info) => {
      const h = await launchWriting('experiment', 1, false)
      const priority = important ? ' !important' : ''
      const html = `<p style="margin:1em 0${priority};padding:0.5em${priority}">alpha</p>bravo<p>charlie</p>`
      try {
        await h.seed({ wordCount: 3, scenes: [{ id: 'css-owner', html }] })
        const result = await h.frames()[0].evaluate(spacing => {
          const root = document.querySelector<HTMLElement>('[data-scene-id]')!
          const nodes = Array.from(root.childNodes)
          const block = root.firstElementChild as HTMLElement
          const text = nodes[1]
          const authored = root.innerHTML
          const sheet = new CSSStyleSheet()
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
          const measure = () => {
            const range = document.createRange()
            range.selectNode(text)
            const selection = window.getSelection()!
            const caret = document.createRange()
            caret.setStart(text, 0)
            caret.collapse(true)
            return { block: block.getBoundingClientRect().toJSON(), raw: range.getBoundingClientRect().toJSON(), caret: caret.getBoundingClientRect().toJSON(),
              marginBottom: getComputedStyle(block).marginBottom, paddingBottom: getComputedStyle(block).paddingBottom,
              anchorIsRaw: selection.anchorNode === text, anchorOffset: selection.anchorOffset }
          }
          document.getElementById('editor')!.focus({ preventScroll: true })
          window.getSelection()!.setBaseAndExtent(text, 0, text, 0)
          const before = measure()
          const em = parseFloat(getComputedStyle(root).fontSize)
          sheet.replaceSync(spacing === 'margin'
            ? '#editor [data-scene-id] > p:first-child { margin-bottom:9em !important; }'
            : '#editor [data-scene-id] > p:first-child::after { content:"";display:block;height:8em;pointer-events:none;user-select:none; }')
          const after = measure()
          return { authored, unchangedHtml: root.innerHTML === authored,
            connected: nodes.every((node, index) => node.isConnected && root.childNodes[index] === node), spacing, em, before, after }
        }, spacing)
        const serialized = await h.page.evaluate(() => window.writingPanes[0].serialize()[0].html)
        await h.page.screenshot({ path: info.outputPath('authored-spacing.png') })
        await writeFile(info.outputPath('css-authored.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(),
          workload: { route: 'experiment', scenes: 1, words: 3, panes: 1, pageView: false }, spacing, important, result, serialized }), null, 2))
        expect(result.authored).toBe(html)
        expect(result.unchangedHtml).toBe(true)
        expect(result.connected).toBe(true)
        expect(serialized).toBe(html)
        expect(result.after.anchorIsRaw).toBe(true)
        expect(result.after.anchorOffset).toBe(0)
        test.fail(important || spacing === 'pseudo', 'Rejected spacing: inline important blocks external margin; generated boxes enlarge the authored block into the gap.')
        expect(result.after.raw.top - result.before.raw.top).toBeCloseTo(8 * result.em)
        expect(result.after.block.bottom).toBe(result.before.block.bottom)
      } finally { await h.close() }
    })
  }
}
