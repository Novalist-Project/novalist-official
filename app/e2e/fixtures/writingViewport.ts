export interface WritingViewport {
  intent<T>(operation: () => T): T
  dispose(): void
}

declare global { interface Window { writingViewport?: WritingViewport } }

export function installWritingViewport(): void {
  const runtime = window as unknown as Window & { NovalistEditorState: {
    editor: HTMLElement; wrapper: HTMLElement; savedScrollTop: number; isFocusing: boolean
  } }
  runtime.writingViewport?.dispose()
  const state = runtime.NovalistEditorState
  const events = new AbortController()
  let generation = 0
  let frame = 0
  let timer = 0
  let deliberate = 0
  let disposed = false

  function cancel(): void {
    generation++
    cancelAnimationFrame(frame)
    clearTimeout(timer)
    frame = timer = 0
    state.isFocusing = false
  }

  function remember(): void { state.savedScrollTop = state.wrapper.scrollTop }

  function intent<T>(operation: () => T): T {
    cancel()
    deliberate++
    try { return operation() }
    finally { deliberate--; remember() }
  }

  function focus(): void {
    if (deliberate || disposed) return
    cancel()
    const token = generation
    const top = state.savedScrollTop
    state.isFocusing = true
    const restore = () => {
      if (token !== generation || disposed) return
      if (state.wrapper.scrollTop !== top) state.wrapper.scrollTop = top
    }
    restore()
    frame = requestAnimationFrame(restore)
    timer = window.setTimeout(() => {
      if (token !== generation || disposed) return
      restore()
      state.isFocusing = false
      remember()
      frame = timer = 0
    }, 100)
  }

  function navigate(): void { cancel(); remember() }

  state.wrapper.addEventListener('scroll', () => {
    if (state.isFocusing && state.wrapper.scrollTop !== state.savedScrollTop) cancel()
    if (!state.isFocusing) remember()
  }, { signal: events.signal })
  for (const event of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'wheel', 'keydown', 'beforeinput']) {
    document.addEventListener(event, navigate, { capture: true, passive: true, signal: events.signal })
  }
  state.editor.addEventListener('focus', focus, { signal: events.signal })
  const dispose = () => {
    disposed = true
    cancel()
    events.abort()
  }
  window.addEventListener('pagehide', dispose, { once: true, signal: events.signal })
  runtime.writingViewport = { intent, dispose }
}
