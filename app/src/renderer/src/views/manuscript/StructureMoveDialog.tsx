import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useDialogKeyboard } from '../../shell/useDialogKeyboard'
import { useWorkspaceDialogGuard } from '../../shell/useWorkspaceDialogGuard'
import type { PlanningStateDto } from '../../stores/planningTypes'
import type { StructureCommand } from '../editor/writingStructureTypes'
import { buildStructureMove, type StructureItem, type StructurePosition, type StructureTarget } from './structureMoves'

export function StructureMoveDialog({ state, item, onSubmit, onCancel }: {
  state: PlanningStateDto; item: StructureItem; onSubmit(command: StructureCommand): void; onCancel(): void
}): React.JSX.Element {
  const { t } = useTranslation()
  useWorkspaceDialogGuard()
  const keyboard = useDialogKeyboard(onCancel)
  const [selected, setSelected] = useState('')
  const [position, setPosition] = useState<StructurePosition>('before')
  const destinations: { key: string; label: string; target: StructureTarget }[] = []
  if (item.kind !== 'scenes') for (const act of state.acts) {
    if (item.kind === 'act' && (!act.name || act.name === item.name)) continue
    destinations.push({ key: `act:${act.name ?? ''}:${act.chapterGuids[0] ?? ''}`, label: act.name ?? t('structure.unassigned'),
      target: { kind: 'act', name: act.name, firstChapterGuid: act.chapterGuids[0] } })
  }
  if (item.kind !== 'act') for (const chapter of [...state.chapters].sort((a, b) => a.order - b.order)) {
    if (item.kind === 'chapters' && item.ids.includes(chapter.guid)) continue
    destinations.push({ key: `chapter:${chapter.guid}`, label: chapter.title, target: { kind: 'chapter', chapterGuid: chapter.guid } })
    if (item.kind === 'scenes') for (const scene of [...chapter.scenes].sort((a, b) => a.order - b.order)) {
      if (!item.ids.includes(scene.id)) destinations.push({ key: `scene:${scene.id}`, label: `${chapter.title} / ${scene.title}`,
        target: { kind: 'scene', chapterGuid: chapter.guid, sceneId: scene.id } })
    }
  }
  const target = destinations.find(destination => destination.key === selected)?.target
  const inside = target && (item.kind === 'chapters' && target.kind === 'act' || item.kind === 'scenes' && target.kind === 'chapter')
  const command = target ? buildStructureMove(state, item, target, inside ? 'inside' : position) : null
  return <div className="dialog-overlay"><div className="dialog-card" role="dialog" aria-modal="true" aria-label={t('structure.move')} {...keyboard}>
    <h2>{t('structure.move')}</h2>
    <label>{t('structure.destination')}<select className="dialog-input" value={selected} onChange={event => setSelected(event.target.value)}>
      <option value="">{t('structure.chooseDestination')}</option>
      {destinations.map(destination => <option key={destination.key} value={destination.key}>{destination.label}</option>)}
    </select></label>
    {inside ? <p>{t('structure.inside')}</p> : <label>{t('structure.position')}
      <select className="dialog-input" value={position} onChange={event => setPosition(event.target.value as StructurePosition)}>
        <option value="before">{t('structure.before')}</option><option value="after">{t('structure.after')}</option>
      </select></label>}
    <div className="dialog-actions"><button className="dialog-button" onClick={onCancel}>{t('dialog.cancel')}</button>
      <button className="dialog-button primary" disabled={!command} onClick={() => { if (command) onSubmit(command) }}>{t('structure.move')}</button></div>
  </div></div>
}
