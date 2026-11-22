import type { TFunction } from 'i18next'

export interface FieldChoice {
  value: string
  label: string
}

export function selectedFieldChoice(value: string, options: FieldChoice[], booleanField: boolean): string {
  return (booleanField ? value.toLowerCase() : value) || options[0]?.value || ''
}

export function fieldTypeLabel(type: string, t: TFunction): string {
  if (type === 'Text') return t('entityTypeManager.textType')
  if (type === 'EntityRefList') return t('entityTypeManager.referenceListType')
  return t(`template.propType.${type.toLowerCase()}`)
}

export function booleanChoices(t: TFunction): FieldChoice[] {
  return [
    { value: 'true', label: t('template.boolTrue') },
    { value: 'false', label: t('template.boolFalse') }
  ]
}
