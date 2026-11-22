import { sceneRefKey, writingContextKey, type WritingDocumentRegistry } from './writingDocuments'
import { findSharedWritingSession, observeSharedWritingSession } from '../collaboration/sharedWritingSessions'
import { findSharedWritingAnnotations } from '../collaboration/sharedWritingAnnotations'
import type { SceneRef, WritingContext } from '../views/editor/writingTypes'
import type { SharedSceneIdentity } from '../../../shared/sharedScene'
import type { EditingSceneClaim } from './projectTypes'

interface SceneClaim { ref: SceneRef; shared?: SharedSceneIdentity; unsubscribeShared?: () => void }
interface RegistryClaims { scenes: Map<string, SceneClaim>; dirty: Map<string, SceneRef>; unsubscribe(): void }

export class WritingEditingClaims {
  private readonly registries = new Map<WritingDocumentRegistry, RegistryClaims>()
  private readonly listeners = new Set<(changed: boolean) => void>()
  private active: { source: string; registry: WritingDocumentRegistry; ref: SceneRef } | null = null

  subscribe(changed: (changed: boolean) => void): () => void {
    this.listeners.add(changed)
    return () => { this.listeners.delete(changed) }
  }

  track(registry: WritingDocumentRegistry): void {
    if (registry.isClosed || this.registries.has(registry)) return
    const state: RegistryClaims = { scenes: new Map(), dirty: new Map(),
      unsubscribe: registry.observeScenes(ref => ref ? this.update(registry, ref) : this.release(registry)) }
    this.registries.set(registry, state)
    for (const snapshot of registry.capture()) this.update(registry, snapshot)
  }

  private update(registry: WritingDocumentRegistry, ref: SceneRef): void {
    const state = this.registries.get(registry)
    if (!state || registry.isClosed) return
    const key = sceneRefKey(ref), snapshot = registry.getSnapshot(ref)
    if (!snapshot) return
    let claim = state.scenes.get(key)
    if (!claim) { claim = { ref: { ...ref } }; state.scenes.set(key, claim) }
    const shared = snapshot.shared ?? undefined
    if (shared?.sessionId !== claim.shared?.sessionId || shared?.itemId !== claim.shared?.itemId) {
      claim.unsubscribeShared?.()
      claim.shared = shared
      claim.unsubscribeShared = shared ? observeSharedWritingSession(shared, () => this.updateDirty(registry, state, claim!)) : undefined
    }
    this.updateDirty(registry, state, claim)
  }

  private updateDirty(registry: WritingDocumentRegistry, state: RegistryClaims, claim: SceneClaim): void {
    if (registry.isClosed) return
    const dirty = registry.isSceneDirty(claim.ref) || !!(claim.shared &&
      (findSharedWritingSession(claim.shared)?.dirty || findSharedWritingAnnotations(registry)?.isSceneDirty(claim.ref)))
    const key = sceneRefKey(claim.ref)
    if (state.dirty.has(key) === dirty) { this.publish(false); return }
    if (dirty) state.dirty.set(key, claim.ref)
    else state.dirty.delete(key)
    this.publish()
  }

  focus(source: string, registry: WritingDocumentRegistry, ref: SceneRef): void {
    this.track(registry)
    if (!registry.getSnapshot(ref)) return
    if (this.active?.source === source && this.active.registry === registry && sceneRefKey(this.active.ref) === sceneRefKey(ref)) return
    this.active = { source, registry, ref: { ...ref } }
    this.publish()
  }

  blur(source: string): void {
    if (this.active?.source !== source) return
    this.active = null
    this.publish()
  }

  read(context: WritingContext, focused: boolean): EditingSceneClaim[] {
    const key = writingContextKey(context), claims = new Map<string, EditingSceneClaim>()
    for (const [registry, state] of this.registries) {
      if (registry.isClosed || writingContextKey(registry.context) !== key) continue
      for (const [sceneKey, ref] of state.dirty) claims.set(sceneKey, { chapterGuid: ref.chapterGuid, sceneId: ref.sceneId, dirty: true })
    }
    const active = this.active
    if (focused && active && !active.registry.isClosed && writingContextKey(active.registry.context) === key) {
      const sceneKey = sceneRefKey(active.ref)
      if (!claims.has(sceneKey)) claims.set(sceneKey, { chapterGuid: active.ref.chapterGuid, sceneId: active.ref.sceneId, dirty: false })
    }
    return [...claims.values()].sort((left, right) => left.sceneId.localeCompare(right.sceneId) || left.chapterGuid.localeCompare(right.chapterGuid))
  }

  private release(registry: WritingDocumentRegistry): void {
    const state = this.registries.get(registry)
    if (!state) return
    state.unsubscribe()
    for (const claim of state.scenes.values()) claim.unsubscribeShared?.()
    this.registries.delete(registry)
    if (this.active?.registry === registry) this.active = null
    this.publish()
  }

  private publish(dirtyChanged = true): void { for (const changed of this.listeners) changed(dirtyChanged) }
}

export const writingEditingClaims = new WritingEditingClaims()
