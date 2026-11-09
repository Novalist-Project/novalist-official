import type { Page } from '@playwright/test'
import './writingContract'

export async function snapshotWriting(page: Page) {
  return page.evaluate(() => ({
    panes: window.writingPanes.map((pane, index) => {
      const scenes = pane.serialize()
      const data = pane.inspect()
      const frameDocument = document.querySelectorAll('iframe')[index].contentDocument!
      const selection = frameDocument.getSelection()!
      const point = (node: Node | null, offset: number) => {
        const element = node?.nodeType === 1 ? node as Element : node?.parentElement
        const root = element?.closest<HTMLElement>('[data-scene-id]')
        if (!root || !node) return null
        const range = frameDocument.createRange(); range.selectNodeContents(root); range.setEnd(node, offset)
        return { sceneId: root.dataset.sceneId, offset: range.toString().length }
      }
      const deltas = data.deltas.map(runs => {
        const identities = new Map<string, number>()
        return runs.map(run => {
          if (!run.attributes?.block) return run
          const blocks: { id: string; tag: string; attributes: Record<string, string> }[] = JSON.parse(run.attributes.block)
          for (const block of blocks) {
            if (!identities.has(block.id)) identities.set(block.id, identities.size)
            block.id = String(identities.get(block.id))
          }
          return { ...run, attributes: { ...run.attributes, block: JSON.stringify(blocks) } }
        })
      })
      return { scenes, deltas, undoGroups: data.undoGroups, redoGroups: data.redoGroups,
        owners: Array.from(frameDocument.querySelectorAll<HTMLElement>('[data-scene-id]'), root => ({ id: root.dataset.sceneId, connected: root.isConnected })),
        selection: { anchor: point(selection.anchorNode, selection.anchorOffset), focus: point(selection.focusNode, selection.focusOffset), text: selection.toString() } }
    }),
    publications: window.writingPublications ?? []
  }))
}
