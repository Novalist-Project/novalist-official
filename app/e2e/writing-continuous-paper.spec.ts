import { expect, test, type Frame } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { launchWriting } from './fixtures/writingHarness'
import { writingProvenance } from './fixtures/writingProvenance'

declare global { interface Window { writingGapEvents: string[] } }

async function state(frame: Frame) {
  return frame.evaluate(() => {
    const root = document.getElementById('editor')!
    const selection = window.getSelection()!
    const paragraphs = Array.from(root.querySelectorAll('p'))
    const path = (node: Node | null): number[] | null => {
      if (!node || !root.contains(node)) return null
      const result: number[] = []
      let current: Node = node
      while (current !== root) {
        const parent: ParentNode = current.parentNode!
        result.unshift(Array.from(parent.childNodes).indexOf(current as ChildNode))
        current = parent
      }
      return result
    }
    interface Shape { kind: string; length?: number; attributes?: Record<string, string>; children?: Shape[] }
    const shape = (node: Node): Shape => node.nodeType === Node.TEXT_NODE
      ? { kind: '#text', length: node.textContent!.length }
      : { kind: node.nodeName, attributes: Object.fromEntries(Array.from((node as Element).attributes, attribute => [attribute.name, attribute.value])), children: Array.from(node.childNodes, shape) }
    const anchorElement = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode as HTMLElement : selection.anchorNode?.parentElement
    return {
      text: root.textContent,
      paragraphs: paragraphs.length,
      markerCount: root.querySelectorAll('[data-writing-gap]').length,
      structure: Array.from(root.childNodes, shape),
      anchorPath: path(selection.anchorNode),
      anchorParagraph: paragraphs.findIndex(p => p.contains(selection.anchorNode)),
      anchorOffset: selection.anchorOffset,
      focusPath: path(selection.focusNode),
      focusParagraph: paragraphs.findIndex(p => p.contains(selection.focusNode)),
      focusOffset: selection.focusOffset,
      collapsed: selection.isCollapsed,
      editableAnchor: anchorElement?.isContentEditable ?? false,
      inputTypes: [...window.writingGapEvents]
    }
  })
}

for (const gap of [false, true]) {
  for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight']) {
    test(`continuous paper rejected marker diagnostic: ${gap ? 'inert marker' : 'control'} ${key}`, async ({}, info) => {
      const h = await launchWriting('original', 1, false)
      try {
        await h.seed({ wordCount: 2, scenes: [{ id: 'gap-owner', html: '<p>alpha</p><p>bravo</p>' }] })
        const frame = h.frames()[0]
        await frame.evaluate(({ gap, key }) => {
          const root = document.getElementById('editor')!
          window.writingGapEvents = []
          root.addEventListener('input', event => window.writingGapEvents.push(event.inputType))
          const paragraphs = root.querySelectorAll('p')
          if (gap) {
            const marker = document.createElement('span')
            marker.dataset.writingGap = ''
            marker.contentEditable = 'false'
            marker.inert = true
            marker.setAttribute('aria-hidden', 'true')
            marker.style.cssText = 'display:block;height:8em;pointer-events:none;user-select:none'
            root.insertBefore(marker, paragraphs[1])
          }
          root.focus({ preventScroll: true })
          const backwards = key === 'Backspace' || key === 'ArrowLeft'
          const node = paragraphs[backwards ? 1 : 0].firstChild!
          window.getSelection()!.setBaseAndExtent(node, backwards ? 0 : 5, node, backwards ? 0 : 5)
        }, { gap, key })
        const before = await state(frame)
        expect(before.paragraphs).toBe(2)
        expect(before.markerCount).toBe(gap ? 1 : 0)
        expect(before.anchorParagraph).toBe(key === 'Backspace' || key === 'ArrowLeft' ? 1 : 0)
        await h.page.keyboard.press(key)
        const result = await state(frame)
        if (key === 'Backspace') await h.page.screenshot({ path: info.outputPath('first-key.png') })
        await h.page.keyboard.press(key)
        const second = await state(frame)
        const samples = [before, result, second].map(({ text, ...sample }) => ({ ...sample, textLength: text!.length, originalTextPreserved: text === 'alphabravo' }))
        await writeFile(info.outputPath('native-gap.json'), JSON.stringify({ provenance: writingProvenance(),
          workload: { route: 'original', appliedAdaptations: false, scenes: 1, words: 2, paragraphs: 2, panes: 1 }, gap, key, samples }, null, 2))
        expect(result.text).toBe('alphabravo')
        expect(result.collapsed).toBe(true)
        test.fail(gap, 'Rejected inert marker adds native caret/deletion stops; no editing emulation is implemented.')
        if (key === 'Backspace' || key === 'Delete') {
          expect(result.paragraphs).toBe(1)
          expect(result.anchorParagraph).toBe(0)
          expect(result.anchorOffset).toBe(5)
        } else {
          expect(result.anchorParagraph).toBe(key === 'ArrowLeft' ? 0 : 1)
          expect(result.anchorOffset).toBe(key === 'ArrowLeft' ? 5 : 0)
        }
        expect(result.editableAnchor).toBe(true)
      } finally { await h.close() }
    })
  }
}
