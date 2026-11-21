import { useRef } from 'react'

/**
 * A side-panel resize handle. `edge` names its edge in the LTR layout;
 * RTL mirrors both the handle position and the direction that grows the panel.
 */
export function PanelResizer({
  edge,
  width,
  onResize,
  onResizeEnd
}: {
  edge: 'left' | 'right'
  width: number
  onResize: (px: number) => void
  /** Fired once when the drag finishes, with the width the store settled on -
   *  the hook for persisting the size rather than writing on every move. */
  onResizeEnd?: (px: number) => void
}): React.JSX.Element {
  const drag = useRef<{ startX: number; startWidth: number; growth: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent): void => {
    const direction = getComputedStyle(e.currentTarget).direction === 'rtl' ? -1 : 1
    drag.current = { startX: e.clientX, startWidth: width, growth: (edge === 'right' ? 1 : -1) * direction }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag.current) return
    const delta = e.clientX - drag.current.startX
    onResize(drag.current.startWidth + delta * drag.current.growth)
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    if (drag.current) onResizeEnd?.(width)
    drag.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
  }

  return (
    <div
      className={`panel-resizer panel-resizer-${edge}`}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}
