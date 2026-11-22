import { useEffect, useState } from 'react'
import { rpc } from '../../rpc/client'
import { useBookScope, useProjectStore } from '../../stores/projectStore'
import { useSharedProjectRevision } from '../../collaboration/sharedProjectNotifications'
import type { ProjectFilter } from '../../stores/filterStore'

const emptyNames = { names: {}, error: null }

export function useWritingEntityNames(filter: ProjectFilter) {
  const scope = useBookScope()
  const epoch = useProjectStore(state => state.workspaceEpoch)
  const character = !!filter.character
  const location = !!filter.location
  const revision = useSharedProjectRevision(value => character || location ? value : 0)
  const [result, setResult] = useState<{ names: Readonly<Record<string, string>>; error: string | null }>(emptyNames)
  useEffect(() => {
    let active = true
    setResult(emptyNames)
    const types = [character ? 'character' : null, location ? 'location' : null].filter(type => type !== null)
    if (!types.length) return
    void Promise.all(types.map(type => rpc.request<{ id: string; name: string }[]>('entities/list', [type])))
      .then(groups => { if (active) setResult({ names: Object.fromEntries(groups.flat().map(entity => [entity.id, entity.name])), error: null }) })
      .catch(error => { if (active) setResult({ names: {}, error: String(error) }) })
    return () => { active = false }
  }, [scope, epoch, revision, character, location])
  return result
}
