const LETTER = /\p{L}/u

/** `dir="auto"` resolves to LTR for text without a strong character (empty, digits only),
 *  so it is only requested once the text has a letter; otherwise the element inherits. */
export function contentDirection(text: string | null | undefined): 'auto' | undefined {
  return text && LETTER.test(text) ? 'auto' : undefined
}

/** For uncontrolled fields whose value changes without a re-render. */
export function syncContentDirection(field: HTMLInputElement | HTMLTextAreaElement): void {
  const direction = contentDirection(field.value)
  if (direction) field.dir = direction
  else field.removeAttribute('dir')
}
