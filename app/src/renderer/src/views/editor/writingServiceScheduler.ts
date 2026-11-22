export interface WritingServiceState {
  visibleSceneIds: readonly string[]
  activeSceneId: string | null
  composingSceneIds: readonly string[]
  selectedSceneIds: readonly string[]
}

export interface WritingServiceSnapshot { sceneId: string; revision: number; contextKey: string }
export interface WritingServiceRequest extends WritingServiceSnapshot {
  signal: AbortSignal
  publish(apply: () => void): boolean
}
export interface WritingSceneServices { dispose(): void | Promise<void> }
export interface WritingServiceOptions {
  snapshot(sceneId: string): WritingServiceSnapshot | undefined
  start(request: WritingServiceRequest): WritingSceneServices | Promise<WritingSceneServices>
  onError?(error: unknown, sceneId: string): void
}

interface RunningService {
  snapshot: WritingServiceSnapshot
  controller: AbortController
  services?: WritingSceneServices
}

/** Keeps asynchronous service ownership tied to a scene revision and workspace. */
export class WritingServiceScheduler {
  private readonly active = new Map<string, RunningService>()
  private readonly pending = new Set<Promise<void>>()
  private readonly failures: unknown[] = []
  private readonly options: WritingServiceOptions
  private composing = new Set<string>()
  private disposed = false

  constructor(options: WritingServiceOptions) { this.options = options }

  update(state: WritingServiceState): void {
    if (this.disposed) return
    this.composing = new Set(state.composingSceneIds)
    const wanted = new Set([...state.visibleSceneIds, ...state.composingSceneIds, ...state.selectedSceneIds])
    if (state.activeSceneId) wanted.add(state.activeSceneId)
    for (const [sceneId, running] of this.active) {
      const snapshot = wanted.has(sceneId) ? this.options.snapshot(sceneId) : undefined
      if (!snapshot || !this.matches(running.snapshot, snapshot)) this.stop(sceneId, running)
    }
    for (const sceneId of wanted) {
      if (this.active.has(sceneId)) continue
      const snapshot = this.options.snapshot(sceneId)
      if (snapshot) this.start(snapshot)
    }
  }

  private matches(left: WritingServiceSnapshot, right: WritingServiceSnapshot): boolean {
    return left.sceneId === right.sceneId && left.contextKey === right.contextKey && left.revision === right.revision
  }

  private start(snapshot: WritingServiceSnapshot): void {
    const running: RunningService = { snapshot: { ...snapshot }, controller: new AbortController() }
    this.active.set(snapshot.sceneId, running)
    const request: WritingServiceRequest = { ...snapshot, signal: running.controller.signal, publish: apply => {
      const current = this.options.snapshot(snapshot.sceneId)
      if (this.disposed || running.controller.signal.aborted || this.composing.has(snapshot.sceneId) || !current || !this.matches(snapshot, current)) return false
      apply()
      return true
    } }
    try {
      const result = this.options.start(request)
      if ('then' in result) this.track(result.then(services => this.accept(running, services), error => {
        if (this.active.get(snapshot.sceneId) === running) this.stop(snapshot.sceneId, running)
        throw error
      }), snapshot.sceneId)
      else this.accept(running, result)
    } catch (error) {
      this.stop(snapshot.sceneId, running)
      this.failed(error, snapshot.sceneId)
    }
  }

  private accept(running: RunningService, services: WritingSceneServices): void {
    if (running.controller.signal.aborted) this.track(Promise.resolve(services.dispose()), running.snapshot.sceneId)
    else running.services = services
  }

  private stop(sceneId: string, running: RunningService): void {
    this.active.delete(sceneId)
    running.controller.abort()
    if (running.services) {
      try { this.track(Promise.resolve(running.services.dispose()), sceneId) }
      catch (error) { this.failed(error, sceneId) }
    }
  }

  private failed(error: unknown, sceneId: string): void {
    if (this.options.onError) this.options.onError(error, sceneId)
    else this.failures.push(error)
  }

  private track(work: Promise<void>, sceneId: string): void {
    const tracked = work.catch(error => this.failed(error, sceneId)).finally(() => this.pending.delete(tracked))
    this.pending.add(tracked)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const [sceneId, running] of this.active) this.stop(sceneId, running)
    while (this.pending.size) await Promise.all(this.pending)
    if (this.failures.length) throw new AggregateError(this.failures, 'Writing services did not complete cleanly.')
  }
}
