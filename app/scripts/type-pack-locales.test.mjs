import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'
import { localizeTypePack } from '../src/renderer/src/views/codex/typePacks.ts'
import { booleanChoices, selectedFieldChoice } from '../src/renderer/src/views/codex/fieldChoices.ts'

const locale = language => JSON.parse(readFileSync(new URL(`../src/renderer/src/locales/${language}.json`, import.meta.url), 'utf8'))
const catalog = locale('en')
const packs = { religion: 5, species: 5, language: 5, faction: 6, magic_system: 6 }

test('a translated starting point retains field IDs, types and stored choices', async () => {
  const i18n = createInstance()
  await i18n.init({ lng: 'ar', resources: { ar: { translation: locale('ar') } } })
  const field = { key: 'belief', displayName: 'Belief', type: 'Bool', defaultValue: 'False', prompt: 'A question' }
  const pack = { typeKey: 'religion', displayName: 'Religion', displayNamePlural: 'Religions', fields: [field] }
  const localized = localizeTypePack(pack, i18n.t)
  assert.equal(localized.displayName, 'ديانة')
  assert.equal(localized.displayNamePlural, 'ديانات')
  assert.deepEqual(localized.fields[0], { ...field, displayName: 'العقيدة', prompt: 'كيف تفسّر هذه الديانة العالم والغاية من وجوده؟' })
  assert.equal(field.displayName, 'Belief')
  const choices = booleanChoices(i18n.t)
  assert.deepEqual(choices.map(option => option.value), ['true', 'false'])
  assert.equal(selectedFieldChoice('False', choices, true), 'false')
  assert.equal(selectedFieldChoice('False', [{ value: 'False', label: 'False' }], false), 'False')
})

test('bundled locales translate every shipped type pack, field and writing prompt', () => {
  for (const language of ['en', 'ar', 'de', 'zh-CN']) {
    const data = locale(language)
    for (const [key, count] of Object.entries(packs)) {
      const pack = data.typePacks[key]
      assert.ok(pack?.name && pack.plural, `${language}: ${key}`)
      assert.equal(Object.keys(pack.fields).length, count)
      for (const id of Object.keys(catalog.typePacks[key].fields)) {
        assert.ok(pack.fields[id]?.name && pack.fields[id].prompt, `${language}: ${key}.${id}`)
        if (language !== 'en') assert.notEqual(pack.fields[id].prompt, catalog.typePacks[key].fields[id].prompt)
      }
    }
  }
})

test('Arabic chapter types, pack names and field choices use the reported writing terms', () => {
  const { chapterTypes, template, typePacks } = locale('ar')
  const plain = value => value.replace(/[\u2066-\u2069]/g, '')
  assert.deepEqual(['chapter', 'prologue', 'epilogue', 'interlude', 'part'].map(key => plain(chapterTypes[key])),
    ['فصل', 'مقدمة', 'خاتمة', 'فاصل سردي', 'قسم'])
  assert.deepEqual(['religion', 'language', 'faction', 'magic_system', 'species'].map(key => plain(typePacks[key].name)),
    ['ديانة', 'لغة', 'جماعة', 'نظام سحري', 'سلالة'])
  assert.deepEqual(['string', 'int', 'bool', 'date', 'enum', 'timespan', 'entityref'].map(key => plain(template[`propType.${key}`])),
    ['نص', 'رقم', 'نعم أو لا', 'تاريخ', 'قائمة خيارات محددة', 'مدة زمنية', 'ربط بعنصر آخر'])
  assert.deepEqual([plain(template.boolTrue), plain(template.boolFalse)], ['نعم', 'لا'])
})
