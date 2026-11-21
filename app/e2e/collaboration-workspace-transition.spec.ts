import { expect, test, type Page } from '@playwright/test'
import { join } from 'node:path'
import { dismissTour, enterWriting, launchApp } from './harness'
import { seedApplicationWritingBook } from './fixtures/writingApplicationBook'

declare global { interface Window { workspaceTransitionErrors: string[] } }

async function watchWorkspaceErrors(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.workspaceTransitionErrors = []
    new MutationObserver(records => {
      if (!records.some(record => record.target instanceof Element && record.target.closest('.toast-host') ||
          [...record.addedNodes].some(node => node instanceof Element && node.matches('.toast-host')))) return
      for (const toast of document.querySelectorAll('.toast-message')) {
        const message = toast.textContent ?? ''
        if (message.includes('The workspace changed') && !window.workspaceTransitionErrors.includes(message)) {
          window.workspaceTransitionErrors.push(message)
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
}

test('opening, sharing and joining a book does not report stale background polls as workspace errors', async () => {
  const owner = await launchApp('nl-workspace-toast-owner-')
  let peer: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    await watchWorkspaceErrors(owner.page)
    const book = await seedApplicationWritingBook(owner, 100)
    await owner.page.evaluate(root => window.novalistStores.project.getState().openProject(root), book.root)
    await dismissTour(owner.page)
    await owner.rpc('collaboration/peer/host', ['127.0.0.1', 0, 'Owner'])
    const invitation = await owner.rpc<string>('collaboration/invite', [new Date(Date.now() + 3600_000).toISOString()])
    peer = await launchApp('nl-workspace-toast-peer-')
    await watchWorkspaceErrors(peer.page)
    await peer.rpc('collaboration/peer/join', [invitation, join(peer.workDir, 'Temporary peer'), 'Peer'])
    await dismissTour(peer.page)
    await enterWriting(owner.page)
    await expect(owner.page.locator('iframe[title="editor"]').contentFrame().locator('[data-writing-scene]')).toHaveCount(100, { timeout: 120_000 })
    await owner.page.waitForTimeout(1100)
    expect(await owner.page.evaluate(() => window.workspaceTransitionErrors)).toEqual([])
    expect(await peer.page.evaluate(() => window.workspaceTransitionErrors)).toEqual([])
  } finally { try { await peer?.close() } finally { await owner.close() } }
})
