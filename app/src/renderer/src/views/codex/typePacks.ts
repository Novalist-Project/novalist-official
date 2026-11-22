import type { TFunction } from 'i18next'

export interface TypePack {
  typeKey: string
  displayName: string
  displayNamePlural: string
  fields: {
    key: string
    displayName: string
    type: string
    defaultValue: string | null
    enumOptions: string[] | null
    required: boolean
    prompt: string
  }[]
  includeImages: boolean
  includeRelationships: boolean
  includeSections: boolean
}

/** Pack text seeds a new editable type. Saved project definitions keep the writer's wording. */
export function localizeTypePack(pack: TypePack, t: TFunction): TypePack {
  return {
    ...pack,
    displayName: t(`typePacks.${pack.typeKey}.name`, { defaultValue: pack.displayName }),
    displayNamePlural: t(`typePacks.${pack.typeKey}.plural`, { defaultValue: pack.displayNamePlural }),
    fields: pack.fields.map(field => ({
      ...field,
      displayName: t(`typePacks.${pack.typeKey}.fields.${field.key}.name`, { defaultValue: field.displayName }),
      prompt: t(`typePacks.${pack.typeKey}.fields.${field.key}.prompt`, { defaultValue: field.prompt })
    }))
  }
}
