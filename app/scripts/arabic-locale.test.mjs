import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseExpression } from '@babel/parser'
import { createInstance } from 'i18next'
import { loadRendererSource } from './renderer-source-loader.mjs'

const localeUrl = language => new URL(`../src/renderer/src/locales/${language}.json`, import.meta.url)
const readLocale = language => JSON.parse(readFileSync(localeUrl(language), 'utf8'))

function flatten(value, prefix = '') {
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return child && typeof child === 'object' && !Array.isArray(child)
      ? Object.entries(flatten(child, path))
      : [[path, child]]
  }))
}

function assertUniqueKeys(node, path = '') {
  if (node.type !== 'ObjectExpression') return
  const keys = new Set()
  for (const property of node.properties) {
    const key = property.key.value
    assert.equal(keys.has(key), false, `Duplicate locale key: ${path}.${key}`)
    keys.add(key)
    assertUniqueKeys(property.value, `${path}.${key}`)
  }
}

const placeholders = text => [...new Set(text.match(/\{\{\w+\}\}|\{\d+\}/g) ?? [])].sort()

test('Arabic is valid UTF-8 JSON without duplicate keys or damaged text', () => {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(localeUrl('ar')))
  JSON.parse(source)
  assertUniqueKeys(parseExpression(source))
  assert.doesNotMatch(source, /[\u00c2\u00c3][\u0080-\u00bf]|\u00d8[\u0080-\u00bf]|\u00d9[\u0080-\u00bf]|\ufffd/)
  assert.doesNotMatch(source, /[\u2600-\u2714\u2716-\u27bf\u{1f300}-\u{1faff}]/u)
})

test('Arabic covers every current English key with matching value types and placeholders', () => {
  const english = flatten(readLocale('en'))
  const arabic = flatten(readLocale('ar'))
  for (const key of Object.keys(arabic)) {
    if (key === 'language.name' || key in english) continue
    const pluralBase = key.replace(/_(zero|two|few|many)$/, '')
    assert.ok(pluralBase !== key && `${pluralBase}_other` in english, `Unexpected Arabic key: ${key}`)
    const expected = placeholders(english[`${pluralBase}_other`])
    const actual = placeholders(arabic[key])
    if (/_(zero|two)$/.test(key) && !actual.includes('{{count}}')) {
      assert.deepEqual(actual, expected.filter(value => value !== '{{count}}'), key)
    } else {
      assert.deepEqual(actual, expected, key)
    }
  }
  assert.match(arabic['language.name'], /العربية/)
  for (const [key, source] of Object.entries(english)) {
    const translated = arabic[key]
    assert.equal(Array.isArray(translated), Array.isArray(source), key)
    if (Array.isArray(source)) continue
    assert.equal(typeof translated, 'string', key)
    assert.ok(translated.trim().length > 0, `${key} is empty`)
    assert.deepEqual(placeholders(translated), placeholders(source), key)
  }
})

test('Arabic plural categories resolve in Arabic for zero, one, two, few, many and other', async () => {
  const english = flatten(readLocale('en'))
  const arabic = flatten(readLocale('ar'))
  const i18n = createInstance()
  await i18n.init({
    lng: 'ar', fallbackLng: 'en', keySeparator: false, nsSeparator: false,
    resources: { ar: { translation: arabic }, en: { translation: english } },
    interpolation: { escapeValue: false }
  })
  for (const key of Object.keys(english).filter(key => key.endsWith('_other'))) {
    const base = key.slice(0, -'_other'.length)
    for (const count of [0, 1, 2, 3, 11, 100]) {
      const result = i18n.t(base, { count, from: 1, to: 4, chapter: 2, removed: 1, returnDetails: true })
      assert.equal(result.usedLng, 'ar', `${base} (${count}) fell back to English`)
      assert.match(result.res, /\p{Script=Arabic}/u, `${base} (${count})`)
      assert.doesNotMatch(result.res, /\{\{|\}\}/, `${base} (${count})`)
    }
  }
})

test('Arabic display isolates remain balanced within each string', () => {
  const arabic = flatten(readLocale('ar'))
  assert.match(arabic['language.name'], /^\u2067.*\u2069$/u)
  for (const [key, value] of Object.entries(arabic)) {
    if (Array.isArray(value)) continue
    assert.doesNotMatch(value, /[\u202a-\u202e]/, key)
    let depth = 0
    for (const character of value) {
      if (/[\u2066-\u2068]/.test(character)) depth++
      if (character === '\u2069') depth--
      assert.ok(depth >= 0, `${key} closes an isolate before opening it`)
    }
    assert.equal(depth, 0, `${key} has an unclosed isolate`)
  }
})

test('Arabic relationship keywords match ordinary role text without direction marks', () => {
  const { relationships } = readLocale('ar')
  const { matchesAny } = loadRendererSource('src/views/relationships/layoutTopology.ts', { '../../i18n': {} })
  for (const [kind, role] of Object.entries({ parent: 'والدة', child: 'ابن', partner: 'زوجة', sibling: 'أخت', pseudo: 'خال' })) {
    const keywords = relationships[kind]
    assert.ok(Array.isArray(keywords) && keywords.length > 0, kind)
    for (const word of keywords) {
      assert.equal(typeof word, 'string', kind)
      assert.equal(word, word.trim(), kind)
      assert.doesNotMatch(word, /[\u202a-\u202e\u2066-\u2069]/, kind)
    }
    assert.equal(matchesAny(role, new Set(keywords)), true, kind)
    assert.equal(matchesAny('صديق', new Set(keywords)), false, kind)
  }
})

test('Arabic import instructions contain readable lines and usable JSON examples', () => {
  const prompt = readLocale('ar').importApi.agentPrompt
  assert.equal(prompt.split('\n').length, readLocale('en').importApi.agentPrompt.split('\n').length)
  assert.doesNotMatch(prompt, /\\[nrt"]/)
  const imageExample = prompt.match(/\{"imageId":[^}]+\}/)?.[0]
  assert.ok(imageExample)
  assert.deepEqual(Object.keys(JSON.parse(imageExample)), ['imageId', 'name', 'alt'])
})
