import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rpc } from '../../rpc/client'
import { useBookScope, useProjectStore } from '../../stores/projectStore'
import { loadBookScoped } from '../../stores/bookScopedLoad'
import { usePlanningStore, type PlanningMode } from '../../stores/planningStore'
import { useManuscriptStore } from '../../stores/manuscriptStore'
import { useManuscriptPropsStore } from '../../stores/manuscriptPropsStore'
import { COLOUR_DIMENSIONS, type ColourDimension } from './sceneColour'
import { PlanningHistory } from './PlanningHistory'

const modes: PlanningMode[] = ['structure', 'corkboard', 'outliner', 'board']

export function PlanningToolbar(): React.JSX.Element {
  const { t } = useTranslation()
  const mode = usePlanningStore(state => state.mode)
  const { freeform, colourBy, groupBy, composed, filterListId } = useManuscriptStore()
  const definitions = useManuscriptPropsStore(state => state.definitions)
  const scope = useBookScope()
  const [lists, setLists] = useState<{ id: string; name: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setLists([])
    void rpc.request<{ id: string; name: string }[]>('smartLists/list')
      .then(result => { if (active) setLists(result) }).catch(reason => { if (active) setError(String(reason)) })
    void useManuscriptPropsStore.getState().load().catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [scope])
  const applyList = async (id: string): Promise<void> => {
    try {
      await loadBookScoped(useProjectStore.getState,
        () => id ? rpc.request<{ sceneId: string }[]>('smartLists/evaluate', [id]) : Promise.resolve(null),
        matches => useManuscriptStore.setState({ filterListId: id, composed: matches?.map(scene => scene.sceneId) ?? null }))
      setError(null)
    } catch (reason) { setError(String(reason)) }
  }
  const groupings = [{ key: 'stage', label: t('stages.title') }, { key: 'chapter', label: t('shell.chapters') },
    { key: 'pov', label: t('common.povWatermark') }, ...definitions.filter(value => value.scope === 'Scene' && value.type !== 'Date')
      .map(value => ({ key: `prop:${value.key}`, label: value.label }))]
  return <>
    <div className="manuscript-toolbar">
      <PlanningHistory />
      <div className="manuscript-modes">{modes.map(value => <button key={value} type="button" className={`codex-tab${value === mode ? ' active' : ''}`}
        onClick={() => usePlanningStore.getState().setMode(value)}>{value === 'structure' ? t('structure.title') : t(`manuscript.viewMode${value.charAt(0).toUpperCase() + value.slice(1)}`)}</button>)}</div>
      {mode === 'corkboard' && <><label className="manuscript-filters match-toggle"><input type="checkbox" checked={freeform}
        onChange={event => useManuscriptStore.getState().setFreeform(event.target.checked)} />{t('corkboard.freeform')}</label>
        <label className="manuscript-filters">{t('corkboard.colourBy')}<select className="inspector-input" value={colourBy}
          onChange={event => useManuscriptStore.getState().setColourBy(event.target.value as ColourDimension)}>
          {COLOUR_DIMENSIONS.map(value => <option key={value} value={value}>{t(`corkboard.colour_${value}`)}</option>)}
        </select></label></>}
      {mode === 'board' && <label className="manuscript-filters">{t('board.groupBy')}<select className="inspector-input" value={groupBy}
        onChange={event => useManuscriptStore.getState().setGroupBy(event.target.value)}>{groupings.map(value => <option key={value.key} value={value.key}>{value.label}</option>)}</select></label>}
      {composed !== null && <div className="manuscript-filters"><span>{t('manuscript.composedCount', { count: composed.length })}</span>
        <button type="button" className="dashboard-range" onClick={() => void applyList('')}>{t('manuscript.showWholeBook')}</button></div>}
      {lists.length > 0 && <select className="dialog-input manuscript-list-filter" value={filterListId} aria-label={t('manuscript.filterList')}
        onChange={event => void applyList(event.target.value)}><option value="">{t('manuscript.filterListNone')}</option>
        {lists.map(list => <option key={list.id} value={list.id}>{list.name}</option>)}</select>}
    </div>
    {error && <p role="alert">{error}</p>}
  </>
}
