import { SharedEditorPresence } from './SharedEditorPresence'
import type { SharedEditorSession } from './SharedEditorSession'
import type { SharedSceneIdentity } from '../../../shared/sharedScene'

interface PresenceTarget { sceneId: string; identity: SharedSceneIdentity; session: SharedEditorSession }

export class WritingSharedPresence {
  private readonly bindings = new Map<string, PresenceTarget & { presence: SharedEditorPresence }>()
  private readonly active: (sceneId: string) => boolean

  constructor(active: (sceneId: string) => boolean) { this.active = active }

  update(targets: readonly PresenceTarget[]): void {
    const wanted = new Map(targets.filter(target => target.identity.presence).map(target => [target.sceneId, target]))
    for (const [id, binding] of this.bindings) {
      const next = wanted.get(id)
      if (next?.session === binding.session && next.identity.sessionId === binding.identity.sessionId &&
          next.identity.itemId === binding.identity.itemId) continue
      binding.presence.close()
      this.bindings.delete(id)
    }
    for (const target of wanted.values()) {
      if (this.bindings.has(target.sceneId)) continue
      this.bindings.set(target.sceneId, { ...target,
        presence: new SharedEditorPresence(target.identity, target.session, () => this.active(target.sceneId)) })
    }
  }

  close(): void {
    for (const binding of this.bindings.values()) binding.presence.close()
    this.bindings.clear()
  }
}
