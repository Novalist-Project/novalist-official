import { findSharedWritingSession } from '../collaboration/sharedWritingSessions'
import { sceneRefKey, type WritingDocumentRegistry } from '../stores/writingDocuments'
import type { SceneRef } from '../views/editor/writingTypes'
import { listTrackedSuggestions } from './trackedSuggestions'

export function observeWritingSuggestionCounts(registry: WritingDocumentRegistry, activeSceneId: string | null,
  changed: (counts: ReadonlyMap<string, number>) => void): () => void {
  const counts = new Map<string, number>()
  const prose = new Map<string, string>()
  const owners = new Map<string, { owner: ReturnType<typeof findSharedWritingSession>; release(): void }>()
  const update = (ref: SceneRef, sharedChange = false): void => {
    if (registry.isClosed) return
    const snapshot = registry.getSnapshot(ref)
    if (!snapshot) return
    const key = sceneRefKey(ref)
    const owner = snapshot.shared ? findSharedWritingSession(snapshot.shared) : undefined
    if (owners.get(key)?.owner !== owner) {
      owners.get(key)?.release()
      owners.delete(key)
      if (owner) owners.set(key, { owner, release: owner.observe(() => update(ref, true)) })
    }
    if (!counts.has(key) && snapshot.revision === 0 && ref.sceneId !== activeSceneId && !registry.isSceneDirty(ref) && !owner?.dirty && !sharedChange) return
    const html = owner?.html ?? snapshot.html
    if (prose.get(key) === html) return
    prose.set(key, html)
    const count = html.includes('data-nl-change') ? listTrackedSuggestions(html).length : 0
    if (counts.get(key) === count) return
    counts.set(key, count)
    changed(new Map(counts))
  }
  const release = registry.observeScenes(ref => { if (ref) update(ref) })
  for (const snapshot of registry.capture()) update(snapshot)
  return () => { release(); for (const binding of owners.values()) binding.release() }
}
