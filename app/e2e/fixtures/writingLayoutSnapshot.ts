import type { Page } from '@playwright/test'
import './writingContract'
import type { WritingPane } from './writingContract'
import type { SceneProjection, SceneSurface } from './writingSceneSurface'

interface SnapshotPane extends WritingPane { views: { root: HTMLElement; surface?: SceneSurface }[]; projection?: SceneProjection }

export async function snapshotWriting(page: Page) {
  return page.evaluate(() => ({
    panes: window.writingPanes.map((pane, index) => {
      const projected = pane as SnapshotPane
      const scenes = pane.serialize()
      const data = pane.inspect()
      const frameDocument = document.querySelectorAll('iframe')[index].contentDocument!
      const selection = frameDocument.getSelection()!
      const point = (node: Node | null, offset: number) => {
        if (projected.projection) {
          const resolved = projected.projection.locate(node, offset)
          if (!resolved) return null
          let length = 0
          for (const fragment of resolved.scene.fragments) {
            const range = frameDocument.createRange()
            range.selectNodeContents(fragment)
            if (fragment.contains(resolved.node)) { range.setEnd(resolved.node, resolved.offset); return { sceneId: resolved.scene.sceneId, offset: length + range.toString().length } }
            length += range.toString().length
          }
          return null
        }
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
        owners: projected.views.map(view => ({ id: view.root.dataset.sceneId, connected: (view.surface?.fragments ?? [view.root]).every(fragment => fragment.isConnected) })),
        selection: { anchor: point(selection.anchorNode, selection.anchorOffset), focus: point(selection.focusNode, selection.focusOffset), text: selection.toString() } }
    }),
    publications: window.writingPublications ?? []
  }))
}
