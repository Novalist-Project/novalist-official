import { useEffect } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWritingZoomStore } from '../../stores/writingZoomStore'
import type { EditorWindow } from './editorBridge'
import { writingFontSize } from './writingTypography'

export function useWritingInitialZoom(live: EditorWindow | null, projectionRevision: number): void {
  const fontSize = useSettingsStore(state => state.view && writingFontSize(state.view.effective))
  const pageView = useSettingsStore(state => state.view?.effective.pageViewEnabled === true)
  const fitPaper = useSettingsStore(state => state.view?.effective.pageViewEnabled || state.view?.effective.enableBookWidth)
  useEffect(() => {
    if (!live || !fontSize || !projectionRevision || useWritingZoomStore.getState().initialized) return
    let cancelled = false
    let observer: MutationObserver | undefined
    const fit = (): void => {
      if (cancelled || !live.frameElement?.isConnected || !live.document.querySelector('[data-writing-scene]')) return
      if (pageView && (!live.document.body.classList.contains('page-view') || !live.document.querySelector('.nv-page'))) return
      const readable = Math.max(100, Math.ceil(22 / fontSize * 10) * 10)
      const fitted = fitPaper ? live.getWritingZoomToFit() * 100 : 100
      useWritingZoomStore.getState().fitOnce(Math.max(readable, fitted))
      observer?.disconnect()
    }
    void live.document.fonts.ready.then(async () => {
      await new Promise<void>(resolve => live.requestAnimationFrame(() => live.requestAnimationFrame(() => resolve())))
      if (cancelled || !live.frameElement?.isConnected || !live.document.querySelector('[data-writing-scene]')) return
      observer = new MutationObserver(fit)
      observer.observe(live.document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
      if (live.document.body.classList.contains('page-view')) live.repaginatePageView()
      fit()
    })
    return () => { cancelled = true; observer?.disconnect() }
  }, [live, fontSize, pageView, fitPaper, projectionRevision])
}
