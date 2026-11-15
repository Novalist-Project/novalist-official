import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { THEME_SHIM, THEME_SHIM_PATH, isThemeShim } from '../src/main/extension-shim.ts'

/** Runs the shim the way a panel does: as a classic script in a page of its own. */
function panel() {
  const attributes = new Map()
  const properties = new Map()
  const listeners = []
  const posted = []
  const root = {
    setAttribute: (name, value) => attributes.set(name, value),
    style: { setProperty: (name, value) => properties.set(name, value) }
  }
  vm.runInNewContext(THEME_SHIM, {
    document: { documentElement: root },
    window: { addEventListener: (type, listener) => listeners.push({ type, listener }) },
    // Copied out of the sandbox: an object made in there has the sandbox's own
    // Object.prototype and is not deep-equal to a literal written out here.
    parent: { postMessage: (message, origin) => posted.push({ message: JSON.parse(JSON.stringify(message)), origin }) }
  })
  assert.deepEqual(listeners.map((entry) => entry.type), ['message'])
  return {
    attributes,
    properties,
    posted,
    receive: (data) => listeners[0].listener({ data })
  }
}

test('the shim is found at the root and under a panel folder, and nowhere else', () => {
  assert.equal(THEME_SHIM_PATH, '/__novalist/theme.js')
  assert.equal(isThemeShim('/__novalist/theme.js'), true)
  assert.equal(isThemeShim('/web/__novalist/theme.js'), true)
  assert.equal(isThemeShim('/web/deep/__novalist/theme.js'), true)
  for (const other of ['/theme.js', '/__novalist/theme.js.map', '/web/__novalist/other.js', '/x__novalist/theme.js']) {
    assert.equal(isThemeShim(other), false, other)
  }
})

test('a panel announces itself once it is listening', () => {
  const page = panel()
  assert.deepEqual(page.posted, [{ message: { novalistThemeReady: true }, origin: '*' }])
  assert.equal(page.attributes.size, 0)
})

test('the language and its direction are stamped onto the panel root', () => {
  const page = panel()
  page.receive({ novalistLanguage: { lang: 'ar', dir: 'rtl' } })
  assert.deepEqual(Object.fromEntries(page.attributes), { lang: 'ar', dir: 'rtl' })

  // Switching back has to undo it: a panel left right-to-left after the writer
  // chose English again would be mirrored for the rest of the session.
  page.receive({ novalistLanguage: { lang: 'en', dir: 'ltr' } })
  assert.deepEqual(Object.fromEntries(page.attributes), { lang: 'en', dir: 'ltr' })
})

test('only rtl mirrors a panel, whatever else the direction says', () => {
  for (const dir of [undefined, null, '', 'auto', 'RTL', 'rtl ', 1, {}]) {
    const page = panel()
    page.receive({ novalistLanguage: { lang: 'de', dir } })
    assert.equal(page.attributes.get('dir'), 'ltr', String(dir))
    assert.equal(page.attributes.get('lang'), 'de')
  }
})

test('a language message without a language changes nothing', () => {
  for (const language of [undefined, null, 'ar', 7, {}, { dir: 'rtl' }, { lang: '', dir: 'rtl' }, { lang: 5, dir: 'rtl' }]) {
    const page = panel()
    page.receive({ novalistLanguage: language })
    assert.equal(page.attributes.size, 0, JSON.stringify(language))
  }
})

test('the theme is stamped on as before and marks the panel ready', () => {
  const page = panel()
  const inherited = Object.create({ '--nl-inherited': 'red' })
  inherited['--nl-surface-card'] = '#181825'
  inherited['--nl-font-ui'] = '15px'
  page.receive({ novalistTheme: inherited })
  assert.deepEqual(Object.fromEntries(page.properties), { '--nl-surface-card': '#181825', '--nl-font-ui': '15px' })
  assert.deepEqual(Object.fromEntries(page.attributes), { 'data-novalist-theme': 'ready' })
})

test('a language message does not claim the theme has arrived', () => {
  const page = panel()
  page.receive({ novalistLanguage: { lang: 'ar', dir: 'rtl' } })
  assert.equal(page.attributes.has('data-novalist-theme'), false)
  assert.equal(page.properties.size, 0)
})

test('one message may carry both, and unrelated messages are ignored', () => {
  const page = panel()
  for (const noise of [undefined, null, '', 'text', 0, {}, { novalistHost: '{}' }]) page.receive(noise)
  assert.equal(page.attributes.size, 0)

  page.receive({ novalistLanguage: { lang: 'ar', dir: 'rtl' }, novalistTheme: { '--nl-text': '#fff' } })
  assert.deepEqual(Object.fromEntries(page.attributes), { lang: 'ar', dir: 'rtl', 'data-novalist-theme': 'ready' })
  assert.deepEqual(Object.fromEntries(page.properties), { '--nl-text': '#fff' })
})
