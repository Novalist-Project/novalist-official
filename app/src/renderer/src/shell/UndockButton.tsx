import { createContext, useContext } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { findPane, useShellStore, type MainView } from '../stores/shellStore'
import { editorPane, useProjectStore } from '../stores/projectStore'
import { useManuscriptStore } from '../stores/manuscriptStore'

/**
 * Tears a pane off into its own window, carrying the project it is looking at
 * and, for the editor, the scene - a window that opened on whichever project
 * happened to be most recent and no scene at all was a window showing "open a
 * project" with nothing able to change it. The pane itself stays where it is.
 */
export async function popOut(view: MainView, paneId = useShellStore.getState().activePaneId): Promise<void> {
  const project = useProjectStore.getState()
  const shell = useShellStore.getState()
  const pane = findPane(shell.panes, paneId)
  const editor = editorPane(project, paneId)
  await window.novalist.openPaneWindow({
    view,
    projectPath: project.projectPath,
    chapterGuid: view === 'write' ? editor.chapterGuid : null,
    sceneId: view === 'write' ? editor.sceneId : null,
    bookId: project.activeBookId,
    draftId: project.activeDraftId,
    writingScope: pane?.kind === 'leaf' ? pane.writingScope : undefined,
    selectedSceneIds: useManuscriptStore.getState().composed,
    // An extension view fills the panes of its window, the editor's included -
    // the mode panel opens one without changing the view underneath - so it
    // travels with whichever pane is undocked.
    extView: shell.extView
  })
}

/** The one control that opens a pane in its own window, wherever it appears. */
export function UndockButton({ paneId, view }: { paneId: string; view: MainView }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      className="undock-button"
      title={t('panes.popOut')}
      aria-label={t('panes.popOut')}
      onClick={() => void popOut(view, paneId)}
    >
      <ExternalLink size={14} strokeWidth={1.75} />
    </button>
  )
}

/**
 * The pane a view's own chrome may offer the undock button for. Set only while
 * the pane header - which carries the button itself - is hidden, so the
 * control appears exactly once per pane.
 */
export const UndockSlot = createContext<{ paneId: string; view: MainView } | null>(null)

/** The undock button for the pane this view is in, when its chrome should carry it. */
export function PaneUndockButton(): React.JSX.Element | null {
  const slot = useContext(UndockSlot)
  return slot ? <UndockButton paneId={slot.paneId} view={slot.view} /> : null
}
