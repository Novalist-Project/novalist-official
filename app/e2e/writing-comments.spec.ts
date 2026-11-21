import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { launchWriting } from './fixtures/writingHarness'
import { writingProvenance } from './fixtures/writingProvenance'
import { writingDiagnosticEvidence } from './fixtures/writingDiagnosticEvidence.mts'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

const image = '<img src="images/synthetic.png" width="12" height="12">'
const body = 'alpha <b title="bold">bravo</b><span class="nv-comment" data-comment-id="existing">echo</span><a href="https://example.invalid">foxtrot</a>' + image + ' charlie'
const paragraph = '<p title="authored">' + body + '</p>'
const comment = (value: string, id = 'comment-0') => `<span class="nv-comment" data-comment-id="${id}">${value}</span>`
const annotated = (first: boolean, last: boolean, id = 'comment-0') => '<p title="authored">' + (first ? 'al' + comment('pha ', id) : comment('alpha ', id))
  + '<b title="bold">' + comment('bravo', id) + '</b><span class="nv-comment" data-comment-id="existing">' + comment('echo', id)
  + '</span><a href="https://example.invalid">' + comment('foxtrot', id) + '</a>' + comment(image + (last ? ' ch' : ' charlie'), id) + (last ? 'arlie' : '') + '</p>'

for (const shape of ['same', 'two', 'paper', 'scenes'] as const) for (const backward of [false, true]) test(`comment leaves: ${shape} ${backward ? 'backward' : 'forward'}`, async ({}, info) => {
  const h = await launchWriting('experiment', 2, false)
  const count = shape === 'paper' ? 40 : shape === 'same' ? 1 : 2
  const scenes = shape === 'scenes' ? [{ id: 'first', html: paragraph }, { id: 'second', html: paragraph }, { id: 'neighbor', html: '<p>neighbor</p>' }]
    : [{ id: 'first', html: paragraph.repeat(count) + '<p>untouched</p>' }, { id: 'neighbor', html: '<p>neighbor</p>' }]
  try {
    await h.page.route('**/images/synthetic.png', route => route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64') }))
    await h.seed({ wordCount: count * 6 + 1, scenes })
    const peer = await h.frames()[1].evaluateHandle(() => {
      const root = document.getElementById('editor')!
      const paragraphs = root.querySelectorAll('p')
      const anchor = paragraphs[0], focus = paragraphs[1]
      const selection = window.getSelection()!
      selection.setBaseAndExtent(focus, 0, anchor, 0)
      return () => selection.anchorNode === focus && selection.anchorOffset === 0 && selection.focusNode === anchor && selection.focusOffset === 0
    })
    const writer = await h.frames()[0].evaluateHandle(({ shape, backward }) => {
      const editor = window as unknown as EditorWindow & { sendMessage(message: object): void }
      const root = document.getElementById('editor')!
      const originals = Array.from(root.querySelectorAll('p,b,a,img,span'))
      const attributes = originals.map(node => Array.from(node.attributes, attribute => [attribute.name, attribute.value]))
      window.parent.writingPublications = []
      editor.sendMessage = message => {
        const content = message as { type: string; sceneId: string; html: string }
        if (content.type === 'contentChanged') window.parent.writingPublications.push({ sceneId: content.sceneId, html: content.html })
      }
      editor.setImageBase('novalist-project://synthetic/')
      if (shape === 'paper') editor.setPageView(true)
      const paragraphs = Array.from(root.querySelectorAll('p'))
      const first = shape === 'paper' ? root.querySelector('.nv-page')!.querySelectorAll('p').length - 1 : 0
      const last = shape === 'same' ? first : first + 1
      const start = paragraphs[first].firstChild!, end = paragraphs[last].lastChild!
      root.focus({ preventScroll: true })
      const selection = window.getSelection()!
      if (backward) selection.setBaseAndExtent(end, 3, start, 2)
      else selection.setBaseAndExtent(start, 2, end, 3)
      window.parent.writingPanes[0].command('wrapSelectionAsComment')
      const startPiece = paragraphs[first].childNodes[1].firstChild!
      return () => ({ first, last, sameContainers: originals.every(node => node.isConnected),
        attributes: originals.every((node, index) => attributes[index].every(([name, value]) => name === 'src' ? node.getAttribute('data-nv-src') === value : node.getAttribute(name) === value)),
        startExact: (backward ? selection.focusNode : selection.anchorNode) === startPiece && (backward ? selection.focusOffset : selection.anchorOffset) === 0,
        endExact: (backward ? selection.anchorNode : selection.focusNode) === end && (backward ? selection.anchorOffset : selection.focusOffset) === 3,
        originalPrefix: start.textContent === 'al',
        noExtractedAncestors: !root.querySelector('.nv-comment p,.nv-comment section,.nv-comment .nv-page'),
        pages: root.querySelectorAll(':scope > .nv-page').length })
    }, { shape, backward })
    const actual = await h.frames()[0].evaluate(check => check(), writer)
    const peerExact = await h.frames()[1].evaluate(check => check(), peer)
    const after = await h.page.evaluate(() => window.writingPanes.map(pane => ({ output: pane.serialize(), groups: pane.inspect().undoGroups })))
    const expected = scenes.map(scene => scene.html)
    if (shape === 'scenes') { expected[0] = annotated(true, false); expected[1] = annotated(false, true, 'comment-1') }
    else expected[0] = Array.from({ length: count }, (_, index) => index >= actual.first && index <= actual.last ? annotated(index === actual.first, index === actual.last) : paragraph).join('') + '<p>untouched</p>'
    await h.page.waitForTimeout(200)
    const publications = await h.page.evaluate(() => window.writingPublications)
    await h.page.evaluate(() => window.writingPanes[0].undo())
    const undone = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
    await h.page.evaluate(() => window.writingPanes[0].redo())
    const redone = await h.page.evaluate(() => window.writingPanes.map(pane => pane.serialize()))
    await writeFile(info.outputPath('comments-leaves.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), workload: { shape, backward }, result: { actual, peerExact, after, publications, undone, redone } }), null, 2))
    expect(actual).toMatchObject({ sameContainers: true, attributes: true, startExact: true, endExact: true, originalPrefix: true, noExtractedAncestors: true })
    expect(peerExact).toBe(true)
    if (shape === 'paper') expect(actual.pages).toBeGreaterThan(1)
    for (const pane of after) expect(pane.output.map(scene => scene.html)).toEqual(expected)
    expect(after[0].groups).toEqual([shape === 'scenes' ? [1, 0] : [0]])
    expect(publications.sort((a, b) => a.sceneId.localeCompare(b.sceneId))).toEqual(scenes.flatMap((scene, index) => scene.html === expected[index] ? [] : [{ sceneId: scene.id, html: expected[index] }]).sort((a, b) => a.sceneId.localeCompare(b.sceneId)))
    for (const pane of undone) expect(pane.map(scene => scene.html)).toEqual(scenes.map(scene => scene.html))
    for (const pane of redone) expect(pane.map(scene => scene.html)).toEqual(expected)
    await writer.dispose(); await peer.dispose()
  } finally { await h.close() }
})

test('comment metadata: duplicate IDs remain scene-owned through delayed card callbacks and removal', async ({}, info) => {
  const h = await launchWriting('experiment', 2, false)
  const html = '<p><span class="nv-comment" data-comment-id="duplicate">alpha</span></p>'
  try {
    await h.seed({ wordCount: 2, scenes: [{ id: 'first', html }, { id: 'second', html }] })
    const result = await h.frames()[0].evaluate(async () => {
      const editor = window as unknown as EditorWindow & {
        setCommentsData(data: { id: string; anchorText: string; text: string }[], sceneId?: string): void
        removeCommentSpan(id: string, sceneId?: string): void
        renderCommentGutter(): void
        sendMessage(message: object): void
      }
      const messages: object[] = []
      editor.sendMessage = message => messages.push(message)
      editor.setCommentsData([{ id: 'duplicate', anchorText: 'alpha', text: 'first record' }], 'first')
      editor.setCommentsData([{ id: 'duplicate', anchorText: 'alpha', text: 'second record' }], 'second')
      editor.renderCommentGutter()
      const cards = Array.from(document.querySelectorAll<HTMLElement>('.nv-cc-card'))
      const values = cards.map(card => ({ sceneId: card.dataset.sceneId, text: card.querySelector('textarea')!.value }))
      const first = cards.find(card => card.dataset.sceneId === 'first') ?? cards[0]
      window.parent.writingPanes[0].select({ scene: 1, offset: 1 }, { scene: 1, offset: 1 })
      const before = window.parent.writingPanes[0].serialize()
      first.querySelector('textarea')!.value = 'edited first record'
      first.querySelector('textarea')!.dispatchEvent(new Event('input', { bubbles: true }))
      const afterMetadata = window.parent.writingPanes[0].serialize()
      const metadataGroups = window.parent.writingPanes[0].inspect().undoGroups
      first.querySelector('button')!.click()
      editor.removeCommentSpan('duplicate', 'first')
      window.parent.writingPanes[0].capture()
      await new Promise(resolve => setTimeout(resolve, 180))
      editor.renderCommentGutter()
      const remaining = Array.from(document.querySelectorAll<HTMLElement>('.nv-cc-card'), card => ({ sceneId: card.dataset.sceneId, text: card.querySelector('textarea')!.value }))
      return { values, messages, before, afterMetadata, metadataGroups, remaining, output: window.parent.writingPanes.map(pane => pane.serialize()) }
    })
    await writeFile(info.outputPath('comments-metadata.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), result }), null, 2))
    expect(result.values).toEqual([{ sceneId: 'first', text: 'first record' }, { sceneId: 'second', text: 'second record' }])
    expect(result.messages).toContainEqual({ type: 'commentTextChanged', sceneId: 'first', commentId: 'duplicate', text: 'edited first record' })
    expect(result.messages).toContainEqual({ type: 'commentDeleted', sceneId: 'first', commentId: 'duplicate' })
    expect(result.afterMetadata).toEqual(result.before)
    expect(result.metadataGroups).toEqual([])
    expect(result.remaining).toEqual([{ sceneId: 'second', text: 'second record' }])
    for (const pane of result.output) expect(pane.map(scene => scene.html)).toEqual(['<p><span>alpha</span></p>', html])
  } finally { await h.close() }
})

test('comment identity: repeated commands allocate new scene-owned IDs and ignore hidden scenes', async ({}, info) => {
  const h = await launchWriting('experiment', 2, false)
  try {
    const html = '<p>alpha bravo</p>'
    await h.seed({ wordCount: 6, scenes: [{ id: 'first', html }, { id: 'hidden', html }, { id: 'last', html }] })
    const result = await h.page.evaluate(() => {
      const pane = window.writingPanes[0]
      pane.scope([0, 2])
      pane.select({ scene: 0, offset: 1 }, { scene: 2, offset: 4 })
      pane.command('wrapSelectionAsComment')
      pane.command('wrapSelectionAsComment')
      const output = window.writingPanes.map(pane => pane.serialize())
      const first = document.querySelector('iframe')!.contentDocument!
      const ids = Array.from(first.querySelectorAll('[data-scene-id]'), scene => ({ id: scene.getAttribute('data-scene-id'), marks: Array.from(scene.querySelectorAll('[data-comment-id]'), mark => mark.getAttribute('data-comment-id')) }))
      return { output, ids, groups: pane.inspect().undoGroups }
    })
    await writeFile(info.outputPath('comments-identities.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), result }), null, 2))
    expect(result.ids.find(scene => scene.id === 'first')!.marks).toEqual(['comment-0', 'comment-0-1'])
    expect(result.ids.find(scene => scene.id === 'last')!.marks).toEqual(['comment-2', 'comment-2-1'])
    expect(result.output[0]).toEqual(result.output[1])
    expect(result.output[0][1].html).toBe(html)
    expect(result.groups).toEqual([[2, 0], [2, 0]])
  } finally { await h.close() }
})

test('comment attribute-only formatting publishes despite unchanged text and retains unrelated peer work', async ({}, info) => {
  const h = await launchWriting('experiment', 2, false)
  try {
    const html = '<p><span class="nv-comment" data-comment-id="duplicate" title="before">alpha</span></p>'
    await h.seed({ wordCount: 2, scenes: [{ id: 'first', html }, { id: 'neighbor', html }] })
    const result = await h.frames()[0].evaluate(() => {
      const editor = window as unknown as EditorWindow & { reportContentChanged(): void; sendMessage(message: object): void }
      const publications: object[] = []
      editor.sendMessage = message => publications.push(message)
      const root = document.querySelector<HTMLElement>('[data-scene-id="first"]')!
      const beforeLayout = root.innerText
      const savedVisibility = root.style.contentVisibility
      root.style.contentVisibility = 'visible'
      const visibleText = root.innerText
      root.style.contentVisibility = savedVisibility
      if (!root.getAttribute('style')) root.removeAttribute('style')
      root.querySelector('[data-comment-id]')!.setAttribute('title', 'after')
      const pane = window.parent.writingPanes[0]
      pane.capture()
      editor.reportContentChanged()
      const after = window.parent.writingPanes.map(pane => pane.serialize())
      pane.remoteInsert(1, 0, 'remote ')
      pane.undo()
      const undone = window.parent.writingPanes.map(pane => pane.serialize())
      pane.redo()
      return { after, undone, redone: window.parent.writingPanes.map(pane => pane.serialize()), publications, visibilityControl: { beforeLayout: { text: beforeLayout }, visible: { text: visibleText } } }
    })
    await writeFile(info.outputPath('comments-attributes.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), result }), null, 2))
    for (const pane of result.after) { expect(pane[0].html).toBe(html.replace('before', 'after')); expect(pane[0].text).toBe('alpha') }
    for (const pane of result.undone) { expect(pane[0].html).toBe(html); expect(pane[1].text).toBe('remote alpha') }
    for (const pane of result.redone) { expect(pane[0].html).toBe(html.replace('before', 'after')); expect(pane[1].text).toBe('remote alpha') }
    expect(result.publications).toEqual([{ type: 'contentChanged', sceneId: 'first', html: html.replace('before', 'after'), plainText: 'alpha' }])
  } finally { await h.close() }
})

for (const [name, html] of Object.entries({
  link: '<a href="https://example.invalid" title="imported">lead<p>alpha</p>middle<p>bravo</p>tail</a>',
  legacy: '<span class="nv-comment" data-comment-id="legacy">lead<p>alpha</p>middle<p>bravo</p>tail</span>',
  linkBlocks: '<a href="https://example.invalid" title="imported"><p>alpha</p><p>bravo</p></a>',
  legacyBlocks: '<span class="nv-comment" data-comment-id="legacy"><p>alpha</p><p>bravo</p></span>',
  containers: '<article title="outer"><section title="inner">lead<p>alpha</p><p>bravo</p>tail</section></article>',
  definition: '<dl><dt>lead<p>alpha</p></dt><dd><p>bravo</p>tail</dd></dl>',
  adjacent: '<p><span title="retained" style="border:1px solid">alpha</span><span title="retained" style="border:1px solid">bravo</span></p>',
  empty: '<p>alpha<span title="retained" style="display:inline-block;width:10px;border:1px solid"></span>bravo</p>'
})) test(`comment mapper preservation: ${name}`, async ({}, info) => {
  const h = await launchWriting('experiment', 2, false)
  try {
    await h.seed({ wordCount: 5, scenes: [{ id: 'imported', html }] })
    const result = await h.page.evaluate(() => ({ output: window.writingPanes.map(pane => pane.serialize()), state: window.writingPanes[0].inspect() }))
    await writeFile(info.outputPath('comments-mapper.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), case: name, result }), null, 2))
    expect(result.output.map(pane => pane[0].html)).toEqual([html, html])
    if (!['adjacent', 'empty'].includes(name)) {
      const paths = result.state.deltas[0].filter(run => run.attributes?.block).map(run => JSON.parse(run.attributes!.block) as { id: string; tag: string }[])
      const tag = name === 'containers' ? 'article' : name === 'definition' ? 'dl' : name.startsWith('link') ? 'a' : 'span'
      expect(paths.some(path => path[0]?.tag === tag)).toBe(true)
      expect(new Set(paths.flatMap(path => path.filter(block => block.tag === 'p').map(block => block.id))).size).toBe(2)
    }
  } finally { await h.close() }
})

test('comment mapper: authored scene and paper lookalikes retain structural identity without becoming owners', async ({}, info) => {
  test.skip(process.env.NOVALIST_WRITING_FRAGMENTS !== '1', 'Requires registered fragment/paper ownership')
  const h = await launchWriting('experiment', 2, false)
  const html = '<section class="nv-page" data-scene-id="pretend" data-writing-fragment="pretend"><p>alpha</p><p>bravo</p></section>'
  try {
    await h.seed({ wordCount: 2, scenes: [{ id: 'actual', html }] })
    const result = await h.page.evaluate(() => ({ output: window.writingPanes.map(pane => pane.serialize()), count: window.writingPanes[0].sceneCount(), deltas: window.writingPanes[0].inspect().deltas }))
    await writeFile(info.outputPath('comments-lookalikes.json'), JSON.stringify(writingDiagnosticEvidence({ provenance: writingProvenance(), result }), null, 2))
    expect(result.count).toBe(1)
    expect(result.output.map(pane => pane[0].html)).toEqual([html, html])
    expect(result.deltas[0].filter(run => run.attributes?.block).every(run => JSON.parse(run.attributes!.block)[0]?.tag === 'section')).toBe(true)
  } finally { await h.close() }
})
