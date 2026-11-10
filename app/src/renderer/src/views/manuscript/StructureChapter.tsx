import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, GripVertical, Move, Plus } from 'lucide-react'
import { useProjectStore } from '../../stores/projectStore'
import { flushPendingWrites } from '../../stores/pendingWrites'
import { SceneSynopsisField } from '../../shell/SceneSynopsisField'
import { useChapterSummaryDocument } from './useChapterSummaryDocument'
import type { PlanningChapter, PlanningScene } from '../../stores/planningTypes'

export function StructureChapter({ chapter, collapsed, selected, onToggle, onSelect, onMove, onScene, onChapter }: {
  chapter: PlanningChapter; collapsed: boolean; selected: boolean
  onToggle(): void; onSelect(): void; onMove(): void; onScene(): void; onChapter(): void
}): React.JSX.Element {
  const { t } = useTranslation()
  return <article className="structure-chapter">
    <header>
      <GripVertical aria-hidden="true" />
      <input type="checkbox" checked={selected} onChange={onSelect} aria-label={t('structure.selectChapter', { title: chapter.title })} />
      <button type="button" onClick={onToggle} aria-expanded={!collapsed} aria-label={chapter.title}>
        {collapsed ? <ChevronRight /> : <ChevronDown />}<strong>{chapter.title}</strong>
      </button>
      <span className="structure-count">{t('unifiedWriting.words', { count: chapter.scenes.reduce((sum, scene) => sum + scene.wordCount, 0) })}</span>
      <button type="button" onClick={onMove} title={t('structure.move')}><Move /><span>{t('structure.move')}</span></button>
      <button type="button" onClick={onScene}><Plus />{t('structure.newScene')}</button>
      <button type="button" onClick={onChapter}><Plus />{t('unifiedWriting.insertChapter')}</button>
    </header>
    {!collapsed && <ChapterSummary chapter={chapter} />}
  </article>
}

function ChapterSummary({ chapter }: { chapter: PlanningChapter }): React.JSX.Element {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const { document, state } = useChapterSummaryDocument(chapter)
  const save = (): void => {
    void document.flush().then(() => {
      if (!document.dirty) setEditing(false)
    }, () => setEditing(true))
  }
  return <div className="structure-summary">
    {editing ? <>
      <textarea autoFocus value={state.text} disabled={!state.loaded} onChange={event => document.update(event.target.value)} aria-label={t('structure.chapterSummary')} />
      <button type="button" onClick={save}>{t('dialog.ok')}</button>
    </> : <button type="button" className="structure-summary-preview" onClick={() => setEditing(true)}>
      {state.text || t('structure.addChapterSummary')}
    </button>}
    {state.error && <span role="alert">{state.error}</span>}
  </div>
}

export function StructureSceneCard({ chapter, scene, selected, onSelect, onMove }: {
  chapter: PlanningChapter; scene: PlanningScene; selected: boolean; onSelect(): void; onMove(): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const synopsis = useProjectStore(state => state.chapters.find(item => item.guid === chapter.guid)?.scenes.find(item => item.id === scene.id)?.synopsis)
  return <article className={`structure-scene${scene.inactive ? ' inactive' : ''}${selected ? ' selected' : ''}`}>
    <header><GripVertical aria-hidden="true" />
      <input type="checkbox" checked={selected} onChange={onSelect} aria-label={scene.title} />
      <button type="button" className="structure-scene-title" onClick={() => void useProjectStore.getState().openScene(chapter.guid, scene.id)}>{scene.title}</button>
      {scene.inactive && <span>{t('structure.inactive')}</span>}
      <span className="structure-count">{t('unifiedWriting.words', { count: scene.wordCount })}</span>
      <button type="button" onClick={onMove}><Move />{t('structure.move')}</button>
    </header>
    {scene.pov && <p className="structure-pov">{scene.pov}</p>}
    {editing ? <div className="structure-summary">
      <SceneSynopsisField chapterGuid={chapter.guid} sceneId={scene.id} className="structure-synopsis" multiline />
      <button type="button" onClick={() => { void flushPendingWrites().then(() => { setEditing(false); setError(null) }).catch(reason => setError(String(reason))) }}>{t('dialog.ok')}</button>
    </div> : <button type="button" className="structure-summary-preview" onClick={() => setEditing(true)}>{(synopsis ?? scene.synopsis) || t('structure.addSynopsis')}</button>}
    {error && <span role="alert">{error}</span>}
  </article>
}
