import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { metadataBinding } from '../../collaboration/SharedMetadataField'
import { writeSharedMetadata } from '../../collaboration/metadataCommands'
import { useProjectStore } from '../../stores/projectStore'
import { useStageStore, type SceneStage } from '../../stores/stageStore'
import { flushPendingWrites } from '../../stores/pendingWrites'
import { WritingMetadataName, requireWritingMetadataContext } from './WritingMetadataName'
import { writingErrorMessage } from './writingError'
import type { SceneRef, WritingContext } from './writingTypes'
import { ContentSelect } from '../../shell/ContentSelect'

export function WritingSceneName({ scene, title, context }: { scene: SceneRef; title: string; context: WritingContext }): React.JSX.Element {
  const { t } = useTranslation()
  const save = async (value: string): Promise<void> => {
    const state = useProjectStore.getState()
    const record = state.chapters.find(chapter => chapter.guid === scene.chapterGuid)?.scenes.find(item => item.id === scene.sceneId)
    if (!record) throw new Error('writing.sceneUnavailable')
    const binding = metadataBinding(record, 'title')
    if (binding) {
      if (!await writeSharedMetadata(binding, value)) throw new Error('unifiedWriting.metadataSaveFailed')
    } else if (record.sharedFields) throw new Error('unifiedWriting.metadataSaveFailed')
    else await state.renameScene(scene.chapterGuid, scene.sceneId, value)
  }
  return <WritingMetadataName value={title} label={t('dialog.sceneName')} context={context} save={save} />
}

export function WritingSceneStage({ scene, stage, context }: { scene: SceneRef; stage?: SceneStage; context: WritingContext }): React.JSX.Element {
  const { t } = useTranslation()
  const stages = useStageStore(state => state.stages)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const change = async (value: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      requireWritingMetadataContext(context)
      await flushPendingWrites()
      requireWritingMetadataContext(context)
      await useStageStore.getState().setSceneStage(scene.chapterGuid, scene.sceneId, value || null)
    } catch (reason) { setError(writingErrorMessage(reason)) }
    finally { setBusy(false) }
  }
  return <>
    <label className="writing-scene-stage">
      {stage && <span style={{ backgroundColor: stage.color }} />}
      <ContentSelect aria-label={t('stages.setTo')} value={stage?.key ?? ''} disabled={busy}
        onChange={event => void change(event.target.value)}>
        <option value="">{t('stages.untriaged')}</option>
        {stages.map(item => <option dir="auto" key={item.key} value={item.key}>{item.label}</option>)}
      </ContentSelect>
    </label>
    {error && <span className="writing-metadata-error" role="alert">{error}</span>}
  </>
}
