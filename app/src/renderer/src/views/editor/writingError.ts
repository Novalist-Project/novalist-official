import i18n from '../../i18n'

export function writingErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error).replace(/^Error: /, '')
  return i18n.t(message)
}
