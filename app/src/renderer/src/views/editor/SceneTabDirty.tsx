import { useMemo, useSyncExternalStore } from 'react'
import { useProjectStore, type SceneTabRef } from '../../stores/projectStore'
import { writingSceneDirtyIdentity, writingSceneDirtySource } from './writingSceneDirty'

export function SceneTabDirty({ reference }: { reference: SceneTabRef }): React.JSX.Element | null {
  const identity = useProjectStore(writingSceneDirtyIdentity)
  const legacyDirty = useProjectStore(state => window.novalist.isMobile && !!state.dirtyMap[reference.sceneId])
  const source = useMemo(() => writingSceneDirtySource(useProjectStore.getState, reference.chapterGuid, reference.sceneId, identity),
    [identity, reference.chapterGuid, reference.sceneId])
  const dirty = useSyncExternalStore(source.subscribe, source.read)
  return (window.novalist.isMobile ? legacyDirty : dirty) ? <span className="editor-tab-dirty" aria-hidden="true" /> : null
}
