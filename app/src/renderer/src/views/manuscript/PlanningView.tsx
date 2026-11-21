import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useBookScope, useProjectStore } from '../../stores/projectStore'
import { observePlanningMetadata, usePlanningStore } from '../../stores/planningStore'
import { useFilterStore } from '../../stores/filterStore'
import { useManuscriptStore } from '../../stores/manuscriptStore'
import { useHostBridgeStore } from '../../stores/hostBridgeStore'
import { useSharedProjectRevision } from '../../collaboration/sharedProjectNotifications'
import { FilterBar } from '../../shell/FilterBar'
import { SceneBulkBar } from '../../shell/SceneBulkBar'
import { useWritingEntityNames } from '../editor/useWritingEntityNames'
import type { StructureCommand } from '../editor/writingStructureTypes'
import { buildPlanningSections } from './structureProjection'
import { StructureBoard } from './StructureBoard'
import { PlanningToolbar } from './PlanningToolbar'
import { Corkboard } from './Corkboard'
import { Outliner } from './Outliner'
import { Board } from './Board'
import './structure.css'

function reportError(error: unknown): void {
  useHostBridgeStore.getState().pushToast(String(error))
}

export function PlanningView({ onCommand }: { onCommand(command: StructureCommand): Promise<void> }): React.JSX.Element {
  const { t } = useTranslation()
  const { state: loaded, owner, mode, loading, error, load, setPov, setGoalOutcome } = usePlanningStore()
  const scope = useBookScope()
  const epoch = useProjectStore(value => value.workspaceEpoch)
  const projectPath = useProjectStore(value => value.projectPath)
  const bookId = useProjectStore(value => value.activeBookId)
  const draftId = useProjectStore(value => value.activeDraftId)
  const state = owner?.projectPath === projectPath && owner?.workspaceEpoch === epoch && loaded?.bookId === bookId && loaded?.draftId === draftId ? loaded : null
  const sharedRevision = useSharedProjectRevision()
  const filter = useFilterStore(value => value.filter)
  const selectedSceneIds = useManuscriptStore(value => value.composed)
  const entities = useWritingEntityNames(filter)
  const options = useMemo(() => ({ selectedSceneIds, entityNames: entities.names }), [selectedSceneIds, entities.names])
  const sections = useMemo(() => state ? buildPlanningSections(state, filter, options) : [], [state, filter, options])
  useEffect(() => { void load().catch(reportError) }, [load, scope, epoch, sharedRevision])
  useEffect(() => observePlanningMetadata(() => { void load().catch(reportError) }), [load])
  return <div className="manuscript planning-view" aria-busy={loading}>
    <FilterBar />
    <PlanningToolbar />
    {(error || entities.error) && <div role="alert"><p>{error ?? entities.error}</p><button type="button" onClick={() => void load().catch(reportError)}>{t('shell.retry')}</button></div>}
    {state && mode === 'structure' && <StructureBoard state={state} filter={filter} options={options} onCommand={onCommand} />}
    {state && mode === 'corkboard' && <Corkboard sections={sections} />}
    {state && mode === 'outliner' && <Outliner sections={sections} onSetPov={setPov} onSetGoalOutcome={setGoalOutcome} />}
    {state && mode === 'board' && <Board sections={sections} onReload={load} onSetPov={setPov}
      onMoveScenes={(sceneIds, targetChapterGuid) => onCommand({ kind: 'moveScenes', sceneIds, targetChapterGuid, beforeSceneId: null })} />}
    <SceneBulkBar />
  </div>
}
