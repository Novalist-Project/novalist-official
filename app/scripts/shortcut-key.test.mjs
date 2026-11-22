import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { stripTypeScriptTypes } from 'node:module'
import { JSDOM } from 'jsdom'
const root = new URL('../src/renderer/public/editor/', import.meta.url)
const context = vm.createContext({})
const helper = new URL('shortcut-key.js', root)
if (existsSync(helper)) vm.runInContext(readFileSync(helper, 'utf8'), context)
const key = event => context.NovalistShortcutKeys?.key({ key: 'ض', code: 'KeyQ', ctrlKey: true, ...event })
test('modified non-Latin keys use physical code without mutating input', () => {
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
    const event = Object.freeze({ key: 'ش', code: 'KeyA', [modifier]: true })
    assert.equal(context.NovalistShortcutKeys?.key(event), 'a')
    assert.equal(event.key, 'ش')
  }
  assert.equal(key({key:'١',code:'Digit1'}), '1')
  assert.equal(key({key:'ج',code:'BracketLeft'}), '[')
  assert.equal(key({key:'د',code:'BracketRight'}), ']')
  assert.equal(key({key:'ظ',code:'Slash'}), '/')
  assert.equal(key({key:'',code:'KeyB'}), 'b')
})
test('Latin layouts retain logical keys and unmodified Arabic stays prose', () => {
  assert.equal(key({key:'z',code:'KeyY'}), 'z')
  assert.equal(key({key:'a',code:'KeyQ'}), 'a')
  assert.equal(key({key:'é',code:'Digit2'}), 'é')
  assert.equal(key({ctrlKey:false}), 'ض')
})
test('composition and AltGraph never become shortcuts', () => {
  for (const event of [{isComposing:true}, {keyCode:229}, {altGraph:true}, {getModifierState: name => name === 'AltGraph'}]) assert.equal(key(event), null)
})
test('native editing reservations retain Arabic clipboard/history', () => {
  const local = vm.createContext({window:context})
  vm.runInContext(readFileSync(new URL('clipboard-focus.js', root), 'utf8'), local)
  for (const code of ['KeyA','KeyC','KeyV','KeyX','KeyZ','KeyY']) assert.equal(local.isTextEditingShortcut({key:'ش',code,ctrlKey:true}), true)
  assert.equal(local.isTextEditingShortcut({key:'ش',code:'KeyB',ctrlKey:true,metaKey:false}), false)
})

const hotkeys = {}
const listeners = new Map()
const shell = vm.createContext({ exports: hotkeys, require: () => ({ COMMANDS: [] }),
  NovalistShortcutKeys: context.NovalistShortcutKeys,
  window: { addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) } })
const shellSource = stripTypeScriptTypes(readFileSync(new URL('../src/renderer/src/shell/hotkeys.ts', import.meta.url), 'utf8'))
  .replace(/^import .*$/gm, '').replace(/^export \{.*$/gm, '').replace(/export /g, '')
vm.runInContext(shellSource + '\nObject.assign(exports, { matchGesture, eventToGesture, installHotkeys, dispatchForwardedHotkey })', shell)
test('shell matches, records and forwards Arabic save/find and custom bindings', () => {
  const event = { key: 'ش', code: 'KeyS', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
  assert.equal(hotkeys.matchGesture(event, 'Ctrl+S'), true)
  assert.equal(hotkeys.eventToGesture(event), 'Ctrl+S')
  assert.equal(hotkeys.matchGesture({...event,key:'z',code:'KeyY'}, 'Ctrl+Z'), true)
  assert.equal(hotkeys.matchGesture({...event,key:'z',code:'KeyY'}, 'Ctrl+Y'), false)
  assert.equal(hotkeys.eventToGesture({...event,altGraph:true}), null)
  assert.equal(hotkeys.matchGesture({...event,isComposing:true}, 'Ctrl+S'), false)
  const ran = []
  const dispose = hotkeys.installHotkeys(['S','F','Q'].map(letter => ({ gesture:`Ctrl+${letter}`, run:() => ran.push(letter) })))
  for (const code of ['KeyS','KeyF','KeyQ']) assert.equal(hotkeys.dispatchForwardedHotkey({...event,code}), true)
  assert.equal(hotkeys.dispatchForwardedHotkey({...event,altGraph:true}), false)
  assert.deepEqual(ran, ['S','F','Q'])
  dispose()
})

test('both native paste paths retain directed quotations and lists', () => {
  const dom = new JSDOM()
  const document = dom.window.document
  const window = { sanitizeSceneFragment(html) {
    const template = document.createElement('template')
    template.innerHTML = html
    return template.content
  } }
  for (const filename of ['clipboard-focus.js', 'manuscript-editor.js']) {
    const source = readFileSync(new URL(filename, root), 'utf8')
    const paste = source.match(/function sanitizePastedHtml\(html\) \{[\s\S]*?\n\}/)[0]
    const context = vm.createContext({ window, document })
    vm.runInContext(paste, context)
    const host = document.createElement('div')
    host.innerHTML = context.sanitizePastedHtml('<blockquote dir="rtl"><p>English العربية</p></blockquote><ul style="direction:rtl"><li>مرحبا</li></ul>')
    assert.equal(host.querySelector('blockquote').getAttribute('dir'), 'rtl')
    assert.equal(host.querySelector('ul').getAttribute('dir'), 'rtl')
    assert.equal(host.querySelector('li').textContent, 'مرحبا')
  }
  dom.window.close()
})
