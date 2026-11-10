type FocusClaim = { sourceId: string; focusGeneration: number }
type OwnerClaim = FocusClaim & { owner: number; epoch: number }

export class WritingFocusOwner {
  private generation = 0
  private current: OwnerClaim | null = null
  private readonly request: (method: string, params: unknown[]) => Promise<unknown>
  private readonly focusedOwner: () => number | undefined

  constructor(
    request: (method: string, params: unknown[]) => Promise<unknown>,
    focusedOwner: () => number | undefined
  ) {
    this.request = request
    this.focusedOwner = focusedOwner
  }

  async claim(owner: number, sourceId: string, epoch: number): Promise<FocusClaim | null> {
    if (typeof sourceId !== 'string' || sourceId.length === 0 || !Number.isSafeInteger(epoch) || epoch < 0)
      throw new Error('Invalid writing focus request.')
    if (this.focusedOwner() !== owner) return null
    const focusGeneration = ++this.generation
    this.current = { owner, sourceId, epoch, focusGeneration }
    await this.request('scenes/setFocusedWritingOwner', [String(owner), sourceId, epoch, focusGeneration])
    if (this.current?.focusGeneration !== focusGeneration || this.focusedOwner() !== owner) return null
    return { sourceId, focusGeneration }
  }

  async release(owner: number): Promise<void> {
    if (this.current?.owner !== owner) return
    const epoch = this.current.epoch
    this.current = null
    await this.request('scenes/setFocusedWritingOwner', ['', '', epoch, ++this.generation])
  }
}
