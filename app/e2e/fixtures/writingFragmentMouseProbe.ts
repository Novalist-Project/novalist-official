interface MouseSelection {
  anchor: number
  anchorOffset: number
  focus: number
  focusOffset: number
  collapsed: boolean
  scroll: number
}

interface FragmentPointerSample extends MouseSelection {
  type: string; buttons: number; button: number; target: number; x: number; y: number
  pointerType: string | null; pointerId: number | null; primary: boolean | null
  trusted: boolean; time: number; modifiers: boolean[]
}

declare global {
  interface Window {
    writingFragmentMouse: {
      snapshot(): MouseSelection
      events: FragmentPointerSample[]
    }
  }
}

export function installFragmentMouseProbe(): void {
  const root = document.getElementById('editor')!
  const wrapper = document.getElementById('editor-wrapper')!
  const paragraphs = Array.from(root.querySelectorAll('p'))
  const targets = [root, ...root.querySelectorAll('*')]
  const nodes: (Node | null)[] = paragraphs.map(paragraph => paragraph.firstChild)
  const snapshot = (): MouseSelection => {
    const selection = window.getSelection()!
    return { anchor: nodes.indexOf(selection.anchorNode), anchorOffset: selection.anchorOffset,
      focus: nodes.indexOf(selection.focusNode), focusOffset: selection.focusOffset,
      collapsed: selection.isCollapsed, scroll: wrapper.scrollTop }
  }
  const events: Window['writingFragmentMouse']['events'] = []
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'dragstart', 'dragover', 'drop', 'dragend', 'gotpointercapture', 'lostpointercapture']) {
    document.addEventListener(type, event => {
      const mouse = event as MouseEvent
      const pointer = event instanceof PointerEvent ? event : null
      events.push({ type, buttons: mouse.buttons, button: mouse.button, target: targets.indexOf(mouse.target as HTMLElement), x: mouse.clientX, y: mouse.clientY,
        pointerType: pointer?.pointerType ?? null, pointerId: pointer?.pointerId ?? null, primary: pointer?.isPrimary ?? null,
        trusted: event.isTrusted, time: event.timeStamp, modifiers: [mouse.altKey, mouse.ctrlKey, mouse.metaKey, mouse.shiftKey], ...snapshot() })
    }, true)
  }
  window.writingFragmentMouse = { snapshot, events }
}
