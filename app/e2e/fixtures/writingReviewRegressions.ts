import { expect, test, type Page } from '@playwright/test'
import { launchWriting } from './writingHarness'
import './writingContract'

const book = { wordCount: 4, scenes: [
  { id: 'scene-a', html: '<p>alpha bravo</p>' },
  { id: 'scene-b', html: '<p>charlie delta</p>' }
] }
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

async function livePanes(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('iframe'), frame =>
    Array.from(frame.contentDocument!.querySelectorAll<HTMLElement>('[data-scene-id]'), root =>
      ({ id: root.dataset.sceneId, connected: root.isConnected, text: root.textContent })) ))
}

const original = [{ id: 'scene-a', connected: true, text: 'alpha bravo' }, { id: 'scene-b', connected: true, text: 'charlie delta' }]
const replaced = [{ id: 'scene-a', connected: true, text: 'alpha replacement' }, { id: 'scene-b', connected: true, text: ' delta' }]

test('review I1: native replacement retains live owners, peer suffix and compound history', async () => {
  const h = await launchWriting('experiment', 2)
  try {
    await h.seed(book)
    await h.page.evaluate(() => window.writingPanes[0].select({ scene: 0, offset: 6 }, { scene: 1, offset: 7 }))
    await h.page.keyboard.insertText('replacement')
    expect(await livePanes(h.page)).toEqual([replaced, replaced])
    await h.page.keyboard.press(`${modifier}+z`)
    expect(await livePanes(h.page)).toEqual([original, original])
    await h.page.keyboard.press(`${modifier}+Shift+z`)
    expect(await livePanes(h.page)).toEqual([replaced, replaced])
  } finally { await h.close() }
})

test('review N1: event-dispatched replacement reads DataTransfer and preserves native undo', async () => {
  const h = await launchWriting('experiment', 2)
  try {
    await h.seed(book)
    const handled = await h.page.evaluate(() => {
      window.writingPanes[0].select({ scene: 0, offset: 6 }, { scene: 1, offset: 7 })
      const dataTransfer = new DataTransfer()
      dataTransfer.setData('text/plain', 'replacement')
      const event = new InputEvent('beforeinput', { inputType: 'insertReplacementText', data: null, dataTransfer, bubbles: true, cancelable: true })
      document.querySelector('iframe')!.contentDocument!.getElementById('editor')!.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(handled).toBe(true)
    expect(await livePanes(h.page)).toEqual([replaced, replaced])
    await h.page.keyboard.press(`${modifier}+z`)
    expect(await livePanes(h.page)).toEqual([original, original])
    await h.page.keyboard.press(`${modifier}+Shift+z`)
    expect(await livePanes(h.page)).toEqual([replaced, replaced])
  } finally { await h.close() }
})

test('review I1: native cross-scene composition retains owners and one committed history action', async () => {
  const h = await launchWriting('experiment', 2)
  try {
    await h.seed(book)
    await h.page.evaluate(() => window.writingPanes[0].select({ scene: 0, offset: 6 }, { scene: 1, offset: 7 }))
    const session = await h.page.context().newCDPSession(h.page)
    await session.send('Input.imeSetComposition', { text: '漢', selectionStart: 1, selectionEnd: 1 })
    const intercepted = await h.page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true })
      document.querySelector('iframe')!.contentDocument!.getElementById('editor')!.dispatchEvent(event)
      return event.defaultPrevented
    })
    expect(intercepted).toBe(false)
    await session.send('Input.insertText', { text: '漢字' })
    const committed = [{ id: 'scene-a', connected: true, text: 'alpha 漢字' }, { id: 'scene-b', connected: true, text: ' delta' }]
    await expect.poll(() => livePanes(h.page)).toEqual([committed, committed])
    await h.page.keyboard.press(`${modifier}+z`)
    expect(await livePanes(h.page)).toEqual([original, original])
    await h.page.keyboard.press(`${modifier}+Shift+z`)
    expect(await livePanes(h.page)).toEqual([committed, committed])
    await session.detach()
  } finally { await h.close() }
})

test('review I2: native undo and redo survive direct deletion, scope changes and remote insertion', async () => {
  const h = await launchWriting('experiment', 2)
  try {
    await h.seed(book)
    await h.page.evaluate(() => window.writingPanes[0].select({ scene: 0, offset: 0 }, { scene: 1, offset: 13 }))
    await h.page.keyboard.press('Backspace')
    expect((await livePanes(h.page))[0].map(scene => scene.text)).toEqual(['', ''])
    await h.page.evaluate(() => {
      const pane = window.writingPanes[0]
      pane.scope([1])
      pane.remoteInsert(1, 0, 'REMOTE ')
      pane.select({ scene: 1, offset: 7 }, { scene: 1, offset: 7 })
    })
    await h.page.keyboard.press(`${modifier}+z`)
    await h.page.evaluate(() => window.writingPanes[0].scope([0, 1]))
    const restored = await livePanes(h.page)
    expect(restored[0].map(scene => scene.text)).toEqual(['alpha bravo', 'charlie deltaREMOTE '])
    expect(restored[1]).toEqual(restored[0])
    await h.page.keyboard.press(`${modifier}+Shift+z`)
    expect((await livePanes(h.page))[0].map(scene => scene.text)).toEqual(['', 'REMOTE '])
    await h.page.keyboard.press(`${modifier}+z`)
    expect((await livePanes(h.page))[0].map(scene => scene.text)).toEqual(['alpha bravo', 'charlie deltaREMOTE '])
  } finally { await h.close() }
})

for (const backwards of [false, true]) for (const offset of [0, 8]) {
  test(`review I3: ${backwards ? 'backward' : 'forward'} selection survives remote insert at ${offset} and scope round trip`, async () => {
    const h = await launchWriting('experiment', 2)
    try {
      await h.seed(book)
      const result = await h.page.evaluate(({ backwards, offset }) => {
        const first = window.writingPanes[0]
        first.select({ scene: 0, offset: backwards ? 11 : 6 }, { scene: 0, offset: backwards ? 6 : 11 })
        window.writingPanes[1].select({ scene: 1, offset: 3 }, { scene: 1, offset: 3 })
        first.remoteInsert(0, offset, 'XY')
        const inspect = () => Array.from(document.querySelectorAll('iframe'), frame => {
          const selection = frame.contentWindow!.getSelection()!
          const point = (node: Node, offset: number) => {
            const element = node.nodeType === 1 ? node as Element : node.parentElement!
            const scene = element.closest('[data-scene-id]')!
            const range = frame.contentDocument!.createRange()
            range.selectNodeContents(scene); range.setEnd(node, offset)
            return { scene: scene.getAttribute('data-scene-id'), offset: range.toString().length }
          }
          return { text: selection.toString(), anchor: point(selection.anchorNode!, selection.anchorOffset), focus: point(selection.focusNode!, selection.focusOffset) }
        })
        const beforeScope = inspect()
        first.scope([1]); first.scope([0, 1])
        return { beforeScope, afterScope: inspect() }
      }, { backwards, offset })
      const start = offset === 0 ? 8 : 6
      const expected = { text: offset === 0 ? 'bravo' : 'brXYavo',
        anchor: { scene: 'scene-a', offset: backwards ? 13 : start }, focus: { scene: 'scene-a', offset: backwards ? start : 13 } }
      const peer = { text: '', anchor: { scene: 'scene-b', offset: 3 }, focus: { scene: 'scene-b', offset: 3 } }
      expect(result.beforeScope).toEqual([expected, peer])
      expect(result.afterScope).toEqual([expected, peer])
    } finally { await h.close() }
  })
}

test('review I2: each native undo or redo gesture consumes exactly one transaction', async () => {
  const h = await launchWriting('experiment')
  try {
    await h.seed(book)
    await h.page.evaluate(() => window.writingPanes[0].select({ scene: 0, offset: 0 }, { scene: 0, offset: 0 }))
    await h.page.keyboard.insertText('!')
    await h.page.evaluate(() => window.writingPanes[0].select({ scene: 0, offset: 7 }, { scene: 1, offset: 7 }))
    await h.page.keyboard.insertText('replacement')
    await h.page.keyboard.press(`${modifier}+z`)
    expect((await livePanes(h.page))[0].map(scene => scene.text)).toEqual(['!alpha bravo', 'charlie delta'])
    await h.page.keyboard.press(`${modifier}+z`)
    expect((await livePanes(h.page))[0]).toEqual(original)
    await h.page.keyboard.press(`${modifier}+y`)
    expect((await livePanes(h.page))[0].map(scene => scene.text)).toEqual(['!alpha bravo', 'charlie delta'])
    await h.page.keyboard.press(`${modifier}+Shift+z`)
    expect((await livePanes(h.page))[0].map(scene => scene.text)).toEqual(['!alpha replacement', ' delta'])
  } finally { await h.close() }
})

test('review I3: independent collapsed carets retain their text positions across remote updates while scoped away', async () => {
  const h = await launchWriting('experiment', 2)
  try {
    await h.seed(book)
    const result = await h.page.evaluate(() => {
      window.writingPanes[0].select({ scene: 0, offset: 8 }, { scene: 0, offset: 8 })
      window.writingPanes[1].select({ scene: 0, offset: 3 }, { scene: 0, offset: 3 })
      window.writingPanes[0].scope([1])
      const inspect = () => Array.from(document.querySelectorAll('iframe'), frame => {
        const selection = frame.contentWindow!.getSelection()!
        return { collapsed: selection.isCollapsed, offset: selection.anchorOffset, text: selection.anchorNode!.textContent }
      })
      window.writingPanes[0].remoteInsert(0, 0, 'XY')
      const afterRemote = inspect()
      window.writingPanes[0].scope([0, 1])
      return { afterRemote, afterScope: inspect() }
    })
    expect(result.afterRemote[1]).toEqual({ collapsed: true, offset: 5, text: 'XYalpha bravo' })
    expect(result.afterScope).toEqual([{ collapsed: true, offset: 10, text: 'XYalpha bravo' }, { collapsed: true, offset: 5, text: 'XYalpha bravo' }])
  } finally { await h.close() }
})
