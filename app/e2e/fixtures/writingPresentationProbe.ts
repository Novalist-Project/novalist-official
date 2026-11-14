import type * as Y from 'yjs'
import type { WritingPane } from './writingContract'
import type { SceneMarkup } from '../../src/renderer/src/collaboration/sceneMarkup'

interface ProbePane extends WritingPane {
  views: { root: HTMLElement; markup: SceneMarkup; state: { doc: Y.Doc; text: Y.Text } }[]
  history: { capture(views: unknown, indices: number[]): void }
  selection(): unknown
  restore(value: unknown): void
}

declare global {
  interface Window {
    writingWork: { captures: number; reads: number[]; readsByScene: number[][]; snapshots: number[]; restores: number[]; transactions: number; changed: number }
    writingOwnerNodes: HTMLElement[][]
  }
}

export function installPresentationProbe(): void {
  const panes = window.writingPanes as unknown as ProbePane[]
  window.writingOwnerNodes = panes.map(pane => pane.views.map(view => view.root))
  window.writingWork = { captures: 0, reads: panes.map(() => 0), readsByScene: panes.map(pane => pane.views.map(() => 0)), snapshots: panes.map(() => 0), restores: panes.map(() => 0), transactions: 0, changed: 0 }
  const history = panes[0].history
  const capture = history.capture.bind(history)
  history.capture = (views, indices) => { window.writingWork.captures += indices.length; capture(views, indices) }
  panes[0].views.forEach(view => view.state.doc.on('afterTransaction', transaction => {
    window.writingWork.transactions++
    if (transaction.changed.size) window.writingWork.changed++
  }))
  panes.forEach((pane, index) => {
    for (const [scene, view] of pane.views.entries()) {
      const read = view.markup.read.bind(view.markup)
      view.markup.read = () => { window.writingWork.reads[index]++; window.writingWork.readsByScene[index][scene]++; return read() }
    }
    const selection = pane.selection.bind(pane)
    pane.selection = () => { window.writingWork.snapshots[index]++; return selection() }
    const restore = pane.restore.bind(pane)
    pane.restore = value => { window.writingWork.restores[index]++; restore(value) }
  })
  window.writingPublications = []
  window.addEventListener('message', event => {
    if (typeof event.data?.novalistEditor !== 'string') return
    const message = JSON.parse(event.data.novalistEditor)
    if (message.type === 'contentChanged') window.writingPublications.push({ sceneId: message.sceneId, html: message.html })
  })
}
