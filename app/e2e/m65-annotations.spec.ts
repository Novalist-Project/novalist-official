import { test, expect, type FrameLocator, type JSHandle, type Page } from '@playwright/test'
import { dismissTour, launchApp, seedBook, type Harness } from './harness'
import { flushWriting } from './writingTestActions'

/**
 * Footnotes and suggested edits: the two things somebody puts in a scene that
 * are not the prose.
 *
 * Three failures the writer hit in one sitting, none of which any unit test
 * could reach because all three live in the gap between the editor iframe and
 * the panels beside it:
 *
 *   - a footnote's number is where its marker stands in the prose, and only the
 *     new note's number was ever recorded - so a note put in ahead of an
 *     existing one left two notes both called 1 while the page read 1 and 2;
 *   - the list showed whatever it had read when the scene opened, so a note
 *     made in the prose did not appear in it at all;
 *   - somebody else's proposed edits were listed under Footnotes, which is
 *     where a writer's own asides live and the last place anybody looks for a
 *     change another person asked for.
 */

type Footnote = { id: string; number: number; text: string }
type Annotations = { footnotes: Footnote[] }

const TWO_PARAGRAPHS = '<p>Alpha beta gamma.</p><p>Delta epsilon zeta.</p>'

test('Inbox comment decisions and replies survive a later inspector edit and one-step undo', async () => {
  const h = await launchApp('nl-inbox-canonical-')
  try {
    const book = await seedBook(h, { One: ['Annotated'] }, 'Inbox annotations', false)
    const { guid, scenes } = book.chapters[0]
    const sceneId = scenes[0].id
    await dismissTour(h.page)
    await h.rpc('scenes/write', [guid, sceneId, '<p><span class="nv-comment" data-comment-id="note">Alpha</span> beta.</p>', 'Alpha beta.'])
    await h.rpc('scenes/setAnnotations', [guid, sceneId, [{ id: 'note', anchorText: 'Alpha', text: 'Original note', resolved: false }], []])
    await h.page.evaluate(({ guid, sceneId }) => window.novalistStores.project.getState().openScene(guid, sceneId), { guid, sceneId })
    const prose = h.page.frameLocator('.editor-frame').locator(`[data-writing-scene="${sceneId}"]`)
    await prose.locator('p').click()
    await h.page.keyboard.press('End')
    await h.page.keyboard.type(' Pending prose.')
    await h.page.evaluate(() => window.novalistStores.shell.getState().setInspectorTab('inbox'))
    const item = h.page.locator('.inbox-item').filter({ hasText: 'Original note' })
    await item.getByRole('button', { name: 'Make this a to-do', exact: true }).click()
    await item.getByRole('button', { name: 'Reply', exact: true }).click()
    await item.getByPlaceholder('Reply, then press Enter').fill('Keep this reply.')
    await item.getByPlaceholder('Reply, then press Enter').press('Enter')
    await expect(item).toContainText('Keep this reply.')
    await h.page.evaluate(() => window.novalistStores.shell.getState().setInspectorTab('footnotes'))
    const text = h.page.locator('.annotation-comment .outliner-input')
    await text.fill('Edited after Inbox')
    await text.press('Tab')
    await flushWriting(h.page)
    const stored = async () => ({ comments: await h.rpc<{ text: string; isTodo: boolean; replies: { text: string }[] }[]>('inbox/list', [true]) })
    await expect.poll(async () => (await stored()).comments[0]).toMatchObject({ text: 'Edited after Inbox', isTodo: true, replies: [{ text: 'Keep this reply.' }] })
    await prose.locator('p').click()
    await h.page.keyboard.press('ControlOrMeta+z')
    await expect(text).toHaveValue('Original note')
    await flushWriting(h.page)
    await expect.poll(async () => (await stored()).comments[0]).toMatchObject({ text: 'Original note', isTodo: true, replies: [{ text: 'Keep this reply.' }] })
    expect((await h.rpc<{ html: string }>('scenes/read', [guid, sceneId])).html).toContain('Pending prose.')
    await prose.locator('p').click()
    await h.page.keyboard.press('End')
    await h.page.keyboard.type(' Before import.')
    await expect.poll(() => h.page.evaluate(() => {
      const state = window.novalistStores.project.getState(), registry = state.getWritingRegistry()!
      return registry.isSceneDirty({ ...registry.context, chapterGuid: state.openChapterGuid!, sceneId: state.openSceneId! })
    })).toBe(true)
    await h.rpc('review/applyComments', [guid, sceneId, [{ id: 'external', author: 'Reviewer', date: '2026-01-01', text: 'Imported note', anchorText: 'beta' }]])
    const imported = h.page.locator('.annotation-comment .outliner-input').nth(1)
    await expect(imported).toHaveValue('Reviewer: Imported note')
    await imported.fill('Edited imported note')
    await imported.press('Tab')
    await flushWriting(h.page)
    await expect.poll(async () => (await stored()).comments[1].text).toBe('Edited imported note')
    await prose.locator('p').click()
    await h.page.keyboard.press('ControlOrMeta+z')
    await expect(imported).toHaveValue('Reviewer: Imported note')
    await h.page.keyboard.press('ControlOrMeta+z')
    await expect(prose).not.toContainText('Before import.')
    await expect(prose).toContainText('Pending prose.')
    await flushWriting(h.page)
    await expect.poll(async () => (await stored()).comments.map(comment => comment.text)).toEqual(['Original note', 'Reviewer: Imported note'])
  } finally { await h.close() }
})

/** The prose, once it is actually showing the scene that was written. */
async function editorShowing(h: Harness, contains: string): Promise<FrameLocator> {
  const frame = h.page.frameLocator('.editor-frame')
  await expect(frame.locator('#editor')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(async () => (await frame.locator('#editor').innerText()).includes(contains), {
      timeout: 20_000
    })
    .toBe(true)
  return frame
}

/** Puts the caret at the end of a paragraph and drops a footnote marker there. */
async function footnoteAtEndOf(page: Page, sceneId: string, paragraph: number, id: string): Promise<void> {
  await page.frameLocator('.editor-frame').locator(`[data-writing-scene="${sceneId}"] p`).nth(paragraph).click()
  await page.keyboard.press('End')
  await page.evaluate((footnoteId: string) => {
    const frame = document.querySelector('.editor-frame') as HTMLIFrameElement
    ;(frame.contentWindow as unknown as { insertFootnoteAtSelection(id: string): void })
      .insertFootnoteAtSelection(footnoteId)
  }, id)
}

test('a footnote put in ahead of another renumbers both', async () => {
  test.setTimeout(180_000)
  const h = await launchApp('nl-fn-number-')
  const book = await seedBook(h, { One: ['A'] }, 'Footnote ordering fixture', false)
  const { guid } = book.chapters[0]
  const sceneId = book.chapters[0].scenes[0].id
  await dismissTour(h.page)

  await h.rpc('scenes/write', [guid, sceneId, TWO_PARAGRAPHS, 'Alpha beta gamma. Delta epsilon zeta.'])
  await h.page.evaluate(
    (a: { g: string; s: string }) => window.novalistStores.project.getState().openScene(a.g, a.s),
    { g: guid, s: sceneId }
  )
  const frame = await editorShowing(h, 'Alpha')

  // The second paragraph first, then the first one - so the newer note stands
  // ahead of the older one in the prose and takes its number off it.
  await footnoteAtEndOf(h.page, sceneId, 1, 'fn-later-in-the-scene')
  await expect(frame.locator('sup.nv-fn')).toHaveCount(1, { timeout: 10_000 })
  await footnoteAtEndOf(h.page, sceneId, 0, 'fn-earlier-in-the-scene')
  await expect(frame.locator('sup.nv-fn')).toHaveCount(2, { timeout: 10_000 })

  // What the page says.
  expect(await frame.locator('sup.nv-fn').allInnerTexts()).toEqual(['1', '2'])

  // What the book says. These have to be the same thing, and were not: both
  // notes came back as number 1.
  await expect
    .poll(
      async () => {
        const stored = await h.rpc<Annotations>('scenes/getAnnotations', [guid, sceneId])
        return stored.footnotes.map((f) => `${f.number}:${f.id}`)
      },
      { timeout: 15_000 }
    )
    .toEqual(['1:fn-earlier-in-the-scene', '2:fn-later-in-the-scene'])

  await h.close()
})

test('a new footnote shows in the list at once, with the caret in its box', async () => {
  test.setTimeout(180_000)
  const h = await launchApp('nl-fn-live-')
  const book = await seedBook(h, { One: ['A'] }, 'Footnote list fixture', false)
  const { guid } = book.chapters[0]
  const sceneId = book.chapters[0].scenes[0].id
  await dismissTour(h.page)

  await h.rpc('scenes/write', [guid, sceneId, TWO_PARAGRAPHS, 'Alpha beta gamma. Delta epsilon zeta.'])
  await h.page.evaluate(
    (a: { g: string; s: string }) => window.novalistStores.project.getState().openScene(a.g, a.s),
    { g: guid, s: sceneId }
  )
  await editorShowing(h, 'Alpha')

  // Standing somewhere else entirely, which is the ordinary case: the writer is
  // writing, not watching a panel.
  await h.page.evaluate(() => window.novalistStores.shell.getState().setInspectorTab('context'))
  await expect(h.page.locator('.annotation-num')).toHaveCount(0)

  await footnoteAtEndOf(h.page, sceneId, 0, 'fn-written-now')

  // The list is where the note goes, so the list has to be showing.
  await expect
    .poll(() => h.page.evaluate(() => window.novalistStores.shell.getState().inspectorTab), {
      timeout: 15_000
    })
    .toBe('footnotes')
  await expect(h.page.locator('.annotation-num')).toHaveCount(1, { timeout: 15_000 })

  // And the caret is in it, because the moment a note is worth writing is the
  // moment its marker goes in.
  await expect
    .poll(
      () =>
        h.page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null
          return active?.closest('.annotation-row') ? active.tagName : ''
        }),
      { timeout: 15_000 }
    )
    .toBe('INPUT')

  await h.close()
})

test('suggested edits are in the Inbox, and a scene row leads to one', async () => {
  test.setTimeout(180_000)
  const h = await launchApp('nl-sugg-home-')
  const book = await seedBook(h, { One: ['A', 'B'] }, 'Suggestions fixture', false)
  const { guid } = book.chapters[0]
  const [first, second] = book.chapters[0].scenes
  await dismissTour(h.page)

  await h.rpc('scenes/write', [
    guid,
    first.id,
    '<p>Alpha beta gamma<ins data-nl-change="s1" data-nl-author="Reader" data-nl-at="2026-01-01">, indeed</ins>.</p>' +
      '<p><del data-nl-change="s2" data-nl-author="Reader" data-nl-at="2026-01-01">Delta </del>epsilon zeta.</p>',
    'Alpha beta gamma, indeed. epsilon zeta.'
  ])
  await h.rpc('scenes/write', [guid, second.id, '<p>Somewhere else.</p>', 'Somewhere else.'])

  // Standing in the scene with the edits, which is where the writer was when
  // they went looking for them.
  await h.page.evaluate(
    (a: { g: string; s: string }) => window.novalistStores.project.getState().openScene(a.g, a.s),
    { g: guid, s: first.id }
  )
  const frame = await editorShowing(h, 'Alpha')

  // Footnotes is for footnotes. An edit somebody else proposed is not one.
  await h.page.evaluate(() => window.novalistStores.shell.getState().setInspectorTab('footnotes'))
  await expect(h.page.locator('.suggestions-panel')).toHaveCount(0)

  // The Inbox is the tab for things waiting on an answer, and it already held
  // the book-wide list of scenes with edits.
  await h.page.evaluate(() => window.novalistStores.shell.getState().setInspectorTab('inbox'))
  await expect(h.page.locator('.suggestions-panel .suggestion-row')).toHaveCount(2, {
    timeout: 15_000
  })
  const sceneRow = h.page.locator('.inbox-suggestion-row')
  await expect(sceneRow).toHaveCount(1, { timeout: 15_000 })

  // Following the row while already standing in that scene did nothing at all:
  // it opened a scene that was open. It has to end at one of the edits.
  await sceneRow.click()
  await expect(frame.locator('.nv-change-flash')).toHaveCount(1, { timeout: 15_000 })

  await h.close()
})

test('reviewing suggestions preserves unsaved prose and one undo restores the Inbox', async () => {
  const h = await launchApp('nl-suggestion-history-')
  let restore: JSHandle<() => void> | undefined
  try {
    const book = await seedBook(h, { One: ['Review'] }, 'Suggestion review fixture', false)
    const chapter = book.chapters[0], sceneId = chapter.scenes[0].id
    const html = '<p>Opening <ins data-nl-change="add" data-nl-author="Reader" data-nl-at="2026-01-01">new </ins>' +
      '<del data-nl-change="drop" data-nl-author="Reader" data-nl-at="2026-01-01">old </del>ending.</p>'
    await h.rpc('scenes/write', [chapter.guid, sceneId, html, 'Opening new old ending.'])
    await dismissTour(h.page)
    await h.page.evaluate(chapter => window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[0].id), chapter)
    const prose = h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')
    await expect(prose.locator('[data-nl-change]')).toHaveCount(2)
    restore = await h.page.evaluateHandle(() => {
      const client = window.novalistRpc, original = client.request.bind(client)
      client.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === 'writing/commit') throw new Error('The suggestion fixture is holding unsaved text.')
        return original<T>(method, params)
      }
      return () => { client.request = original }
    })
    await prose.locator('p').click()
    await h.page.keyboard.press('End')
    await h.page.keyboard.type(' Locally typed.')
    await h.page.evaluate(() => window.novalistStores.shell.getState().setInspectorTab('inbox'))
    const panel = h.page.locator('.suggestions-panel')
    await expect(panel.locator('.suggestion-row')).toHaveCount(2)
    for (const action of ['Take it', 'Turn it down', 'Take all', 'Turn all down']) {
      await panel.getByRole('button', { name: action, exact: true }).first().click()
      const all = action.endsWith('all') || action === 'Turn all down'
      await expect(prose.locator('[data-nl-change]')).toHaveCount(all ? 0 : 1)
      await expect(prose).toContainText('Locally typed.')
      if (all) await expect(h.page.locator('.inbox-suggestion-row')).toHaveCount(0)
      await prose.locator('p').click()
      await h.page.keyboard.press('ControlOrMeta+z')
      await expect(prose.locator('ins[data-nl-change="add"]')).toHaveText('new ')
      await expect(prose.locator('del[data-nl-change="drop"]')).toHaveText('old ')
      await expect(prose).toContainText('Locally typed.')
      await expect(panel.locator('.suggestion-row')).toHaveCount(2)
      await expect(h.page.locator('.inbox-suggestion-row')).toHaveCount(1)
    }
    await restore.evaluate(reset => reset())
    await flushWriting(h.page)
    expect((await h.rpc<{ html: string }>('scenes/read', [chapter.guid, sceneId])).html).toContain('Locally typed.')
  } finally {
    if (restore && !h.page.isClosed()) await restore.evaluate(reset => reset())
    await h.close()
  }
})
