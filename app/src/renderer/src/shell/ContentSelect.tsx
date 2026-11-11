import { useLayoutEffect, useRef, type SelectHTMLAttributes } from 'react'

/** Native auto direction must inspect the selected label, not the first option. */
export function ContentSelect({ children, onChange, dir, ...props }: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  const select = useRef<HTMLSelectElement>(null)
  const label = useRef<HTMLElement>(null)
  const updateDirection = (): void => {
    if (dir || !select.current || !label.current) return
    label.current.textContent = select.current.selectedOptions[0]?.textContent ?? ''
    select.current.dir = getComputedStyle(label.current).direction
  }
  useLayoutEffect(updateDirection)
  return <>
    <select {...props} ref={select} dir={dir} onChange={event => {
      updateDirection()
      onChange?.(event)
    }}>{children}</select>
    <bdi hidden aria-hidden="true" ref={label} dir="auto" />
  </>
}
