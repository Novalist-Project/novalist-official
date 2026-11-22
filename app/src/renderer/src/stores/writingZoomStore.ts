import { create } from 'zustand'

interface WritingZoomState {
  percent: number
  initialized: boolean
  fitOnce(percent: number): void
  change(delta: number, maxPercent?: number): void
}

export const useWritingZoomStore = create<WritingZoomState>((set) => ({
  percent: 100,
  initialized: false,
  fitOnce: (percent) => {
    if (!Number.isFinite(percent) || percent <= 0) return
    set(state => state.initialized ? state : {
      initialized: true,
      percent: Math.max(50, Math.min(300, Math.floor(percent)))
    })
  },
  change: (delta, maxPercent = 300) => {
    if (!Number.isFinite(delta) || delta === 0) return
    const limit = Math.min(300, Math.floor(maxPercent))
    if (!(limit > 0)) return
    set(state => {
      const next = Math.min(state.percent, limit) + Math.sign(delta) * 10
      return { initialized: true, percent: Math.max(50, Math.min(limit, next)) }
    })
  }
}))
