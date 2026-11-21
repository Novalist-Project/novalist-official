import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rpc } from '../rpc/client'
import type { PlanningStateDto } from '../stores/planningTypes'
import { writingErrorMessage } from '../views/editor/writingError'

export function ChapterActField({ value, onChange }: { value: string; onChange(value: string): void }): React.JSX.Element {
  const { t } = useTranslation()
  const [acts, setActs] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const isMobile = window.novalist.isMobile
  useEffect(() => {
    if (isMobile) return
    let active = true
    void rpc.request<PlanningStateDto>('planning/get').then(state => {
      if (active) setActs([...new Set(state.acts.flatMap(act => act.name ? [act.name] : []))])
    }).catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false }
  }, [isMobile])
  return <>
    {isMobile ? <input className="dialog-input" value={value} placeholder={t('dialog.actWatermark')} onChange={event => onChange(event.target.value)} />
      : <select className="dialog-input" aria-label={t('dialog.act')} value={value} onChange={event => onChange(event.target.value)}>
        <option value="">{t('structure.unassigned')}</option>
        {value && !acts.includes(value) && <option value={value}>{value}</option>}
        {acts.map(act => <option key={act} value={act}>{act}</option>)}
      </select>}
    {!isMobile && <p>{t('unifiedWriting.chapterActMoveHint')}</p>}
    {error && <p role="alert">{writingErrorMessage(error)}</p>}
  </>
}
