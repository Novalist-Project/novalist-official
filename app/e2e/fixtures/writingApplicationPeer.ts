import * as Y from 'yjs'
import { join } from 'node:path'
import { launchApp, type Harness } from '../harness'
import type { ApplicationWritingBook } from './writingApplicationBook'

export async function createApplicationPeer(owner: Harness, book: ApplicationWritingBook) {
  await owner.rpc('collaboration/peer/host', ['127.0.0.1', 0, 'Performance owner'])
  const invitation = await owner.rpc<string>('collaboration/invite', [new Date(Date.now() + 3600_000).toISOString()])
  const guest = await launchApp('nl-writing-performance-peer-')
  const doc = new Y.Doc()
  try {
    await guest.rpc('collaboration/peer/join', [invitation, join(guest.workDir, 'Synthetic peer'), 'Performance peer'])
    await guest.app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide() })
    const scene = book.scenes[Math.floor(book.scenes.length / 2)]
    const content = await guest.rpc<{ shared: { sessionId: string; itemId: string; state: string } }>('scenes/read', [scene.chapterGuid, scene.id])
    Y.applyUpdate(doc, Buffer.from(content.shared.state, 'base64'))
    let updates = 0
    return {
      sceneId: scene.id,
      count: () => updates,
      async update(): Promise<void> {
        const previous = Y.encodeStateVector(doc)
        doc.getText('prose').insert(0, 'r')
        const update = Buffer.from(Y.encodeStateAsUpdate(doc, previous)).toString('base64')
        await guest.rpc('collaboration/writeScene', [content.shared.sessionId, content.shared.itemId, update])
        updates++
      },
      async close(): Promise<void> { doc.destroy(); await guest.close() }
    }
  } catch (error) {
    doc.destroy()
    await guest.close()
    throw error
  }
}
