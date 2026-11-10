import { useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, GripVertical, Move, Pencil, Plus, Trash2 } from 'lucide-react'
import { useSelectionStore } from '../../stores/selectionStore'
import type { PlanningStateDto } from '../../stores/planningTypes'
import type { ProjectFilter } from '../../stores/filterStore'
import { InputDialog } from '../../shell/InputDialog'
import { ConfirmDialog } from '../../shell/ConfirmDialog'
import { StructureChapter, StructureSceneCard } from './StructureChapter'
import { StructureMoveDialog } from './StructureMoveDialog'
import { StructureRepair } from './StructureRepair'
import { buildStructureRows, type StructureRow, type StructureRowOptions } from './structureProjection'
import { buildStructureMove, type StructureItem, type StructureTarget, type StructurePosition } from './structureMoves'
import type { StructureCommand } from '../editor/writingStructureTypes'
import { writingErrorMessage } from '../editor/writingError'
import './structure.css'

interface Props {
  state: PlanningStateDto; filter: ProjectFilter; options?: StructureRowOptions
  onCommand(command: StructureCommand): Promise<void>
}
type Prompt = { title: string; initialValue?: string; create(value: string): StructureCommand }

function useStructureBoard(state: PlanningStateDto, onCommand: Props['onCommand']) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [chapters, setChapters] = useState<ReadonlySet<string>>(new Set())
  const [dragging, setDragging] = useState<StructureItem | null>(null)
  const [over, setOver] = useState<{ key: string; position: StructurePosition } | null>(null)
  const [moving, setMoving] = useState<StructureItem | null>(null)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = useSelectionStore(store => store.sceneIds)
  const toggle = (setter: typeof setCollapsed, key: string): void => setter(current => {
    const next = new Set(current)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const run = (command: StructureCommand): void => {
    flushSync(() => { setPrompt(null); setMoving(null); setRemoving(null); setBusy(true); setError(null) })
    void onCommand(command).catch(reason => setError(String(reason))).finally(() => setBusy(false))
  }
  const itemFor = (row: StructureRow): StructureItem => row.kind === 'act'
    ? { kind: 'act', name: row.act.name ?? '' }
    : row.kind === 'chapter' ? { kind: 'chapters', ids: chapters.has(row.chapter.guid) ? [...chapters] : [row.chapter.guid] }
      : { kind: 'scenes', ids: selected.includes(row.scene.id) ? selected : [row.scene.id] }
  const dragProps = (row: StructureRow) => {
    const target: StructureTarget = row.kind === 'act' ? { kind: 'act', name: row.act.name, firstChapterGuid: row.act.chapterGuids[0] }
      : row.kind === 'chapter' ? { kind: 'chapter', chapterGuid: row.chapter.guid }
        : { kind: 'scene', chapterGuid: row.chapter.guid, sceneId: row.scene.id }
    return {
      draggable: !busy && (row.kind !== 'act' || !!row.act.name),
      onDragStart: (event: React.DragEvent) => {
        if ((event.target as HTMLElement).closest('input,textarea,button,select,.md-editor')) { event.preventDefault(); return }
        setDragging(itemFor(row)); event.dataTransfer.effectAllowed = 'move'
      },
      onDragEnd: () => { setDragging(null); setOver(null) },
      onDragOver: (event: React.DragEvent) => {
        if (!dragging) return
        const rect = event.currentTarget.getBoundingClientRect()
        const fraction = (event.clientY - rect.top) / rect.height
        const inside = row.kind === 'act' && dragging.kind === 'chapters' || row.kind === 'chapter' && dragging.kind === 'scenes'
        const position = inside ? 'inside' : fraction < 0.5 ? 'before' : 'after'
        if (!buildStructureMove(state, dragging, target, position)) return
        event.preventDefault(); setOver({ key: row.key, position })
      },
      onDrop: (event: React.DragEvent) => {
        event.preventDefault()
        const command = dragging && over?.key === row.key ? buildStructureMove(state, dragging, target, over.position) : null
        setDragging(null); setOver(null)
        if (command) run(command)
      }
    }
  }
  return { collapsed, chapters, moving, prompt, removing, busy, error, selected, over, run, itemFor, dragProps,
    setMoving, setPrompt, setRemoving, toggleCollapse: (key: string) => toggle(setCollapsed, key),
    toggleChapter: (key: string) => toggle(setChapters, key) }
}

export function StructureBoard({ state, filter, options, onCommand }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const model = useStructureBoard(state, onCommand)
  const rows = buildStructureRows(state, filter, { ...options, collapsed: model.collapsed })
  return <section className="structure-board" aria-busy={model.busy}>
    {state.issues.length > 0 && <StructureRepair state={state} onCommand={onCommand} />}
    <div className="structure-actions">
      <button type="button" disabled={model.busy} onClick={() => model.setPrompt({ title: t('structure.newAct'), create: name => ({ kind: 'createAct', name, beforeActName: null }) })}><Plus />{t('structure.newAct')}</button>
      <button type="button" disabled={model.busy} onClick={() => model.setPrompt({ title: t('unifiedWriting.insertChapter'), create: title => ({ kind: 'insertChapter', title, beforeChapterGuid: null, actName: [...state.chapters].sort((a, b) => a.order - b.order).at(-1)?.act || null }) })}><Plus />{t('unifiedWriting.insertChapter')}</button>
    </div>
    {model.error && <p role="alert">{writingErrorMessage(model.error)}</p>}
    {rows.map(row => <div key={row.key} inert={model.busy} className={`structure-row structure-${row.kind}-row`} data-drop={model.over?.key === row.key ? model.over.position : undefined} {...model.dragProps(row)}>
      <StructureRowView row={row} state={state} model={model} />
    </div>)}
    {model.prompt && <InputDialog title={model.prompt.title} initialValue={model.prompt.initialValue} onCancel={() => model.setPrompt(null)} onSubmit={value => { if (model.prompt) model.run(model.prompt.create(value)) }} />}
    {model.moving && <StructureMoveDialog state={state} item={model.moving} onSubmit={model.run} onCancel={() => model.setMoving(null)} />}
    {model.removing && <ConfirmDialog title={t('structure.removeAct')} message={t('structure.removeActMessage')} onCancel={() => model.setRemoving(null)} onConfirm={() => { if (model.removing) model.run({ kind: 'removeAct', name: model.removing }) }} />}
  </section>
}

function StructureRowView({ row, state, model }: { row: StructureRow; state: PlanningStateDto; model: ReturnType<typeof useStructureBoard> }): React.JSX.Element {
  const { t } = useTranslation()
  const move = (): void => model.setMoving(model.itemFor(row))
  const insertChapter = (): void => {
    const index = row.kind === 'act' ? state.acts.indexOf(row.act) : -1
    const before = row.kind === 'act' ? state.acts.slice(index + 1).flatMap(act => act.chapterGuids)[0] ?? null : row.chapter.guid
    const actName = row.kind === 'act' ? row.act.name : row.chapter.act || null
    model.setPrompt({ title: `${t('unifiedWriting.insertChapter')} · ${actName ?? t('structure.unassigned')}`,
      create: title => ({ kind: 'insertChapter', title, beforeChapterGuid: before, actName }) })
  }
  if (row.kind === 'act') return <header className="structure-act">
    {row.act.name && <GripVertical aria-hidden="true" />}
    <button type="button" aria-expanded={!model.collapsed.has(row.key)} onClick={() => model.toggleCollapse(row.key)}>
      {model.collapsed.has(row.key) ? <ChevronRight /> : <ChevronDown />}<strong>{row.act.name ?? t('structure.unassigned')}</strong>
    </button>
    <span className="structure-count">{t('structure.chapters', { count: row.act.chapterGuids.length })}</span>
    <button type="button" onClick={insertChapter}><Plus />{t('unifiedWriting.insertChapter')}</button>
    {row.act.name && <><button type="button" onClick={move} title={t('structure.move')}><Move /></button>
      <button type="button" title={t('structure.renameAct')} onClick={() => model.setPrompt({ title: t('structure.renameAct'), initialValue: row.act.name!, create: newName => ({ kind: 'renameAct', oldName: row.act.name!, newName }) })}><Pencil /></button>
      <button type="button" title={t('structure.removeAct')} onClick={() => model.setRemoving(row.act.name)}><Trash2 /></button></>}
  </header>
  if (row.kind === 'chapter') return <StructureChapter chapter={row.chapter} collapsed={model.collapsed.has(row.key)} selected={model.chapters.has(row.chapter.guid)}
    onToggle={() => model.toggleCollapse(row.key)} onSelect={() => model.toggleChapter(row.chapter.guid)} onMove={move} onChapter={insertChapter}
    onScene={() => model.setPrompt({ title: t('structure.newScene'), create: title => ({ kind: 'insertScene', chapterGuid: row.chapter.guid, title, beforeSceneId: null }) })} />
  return <StructureSceneCard chapter={row.chapter} scene={row.scene} selected={model.selected.includes(row.scene.id)}
    onSelect={() => useSelectionStore.getState().toggle(row.scene.id)} onMove={move} />
}
