import { useTranslation } from 'react-i18next'
import type { WritingStructureRequest } from './writingPaneController'

export interface WritingBoundaryRequests {
  scene: WritingStructureRequest | null
  chapter: WritingStructureRequest | null
}

export function WritingBoundaryActions({ requests, onStructure }: {
  requests: WritingBoundaryRequests; onStructure(request: WritingStructureRequest): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { scene, chapter } = requests
  return <div className="writing-boundary-actions">
    {scene && <button type="button" className="writing-boundary-insert" data-writing-insert="scene"
      onClick={() => onStructure(scene)}>+ {t('shell.newScene')}</button>}
    {chapter && <button type="button" className="writing-boundary-insert" data-writing-insert="chapter"
      onClick={() => onStructure(chapter)}>+ {t('shell.newChapter')}</button>}
  </div>
}
