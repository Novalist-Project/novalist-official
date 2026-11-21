import type { SceneRef } from './writingTypes'

function key(ref: SceneRef): string {
  return JSON.stringify([ref.bookId, ref.draftId, ref.chapterGuid, ref.sceneId])
}

export class WritingAnnotationRefresh {
  private wanted = new Map<string, SceneRef>()
  private readonly loaded = new Map<string, number>()
  private revision = 0
  private inFlight = false
  private disposed = false
  private readonly read: (refs: SceneRef[]) => Promise<void>
  private readonly failed: (error: unknown) => void

  constructor(read: (refs: SceneRef[]) => Promise<void>, failed: (error: unknown) => void) {
    this.read = read
    this.failed = failed
  }

  update(refs: SceneRef[], revision: number): void {
    if (this.disposed) return
    this.wanted = new Map(refs.map(ref => [key(ref), ref]))
    this.revision = revision
    this.start()
  }

  private start(): void {
    if (this.disposed || this.inFlight) return
    const revision = this.revision
    const refs = [...this.wanted].filter(([id]) => this.loaded.get(id) !== revision).map(([, ref]) => ref)
    if (!refs.length) return
    this.inFlight = true
    void this.read(refs).then(() => {
      this.inFlight = false
      if (this.disposed) return
      for (const ref of refs) this.loaded.set(key(ref), revision)
      this.start()
    }, error => { this.inFlight = false; if (!this.disposed) this.failed(error) })
  }

  dispose(): void {
    this.disposed = true
    this.wanted.clear()
    this.loaded.clear()
  }
}
