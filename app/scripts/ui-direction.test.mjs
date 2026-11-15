import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RestartAfterQuit, asDirection, launchedDirection, naturalDirection, parseStoredDirection,
  readStoredDirection, relaunchOptions, rememberDirection, restartNeeded, uiDirectionSwitch
} from '../src/main/ui-direction.ts'

test('Windows and Linux force whatever direction was remembered, ltr as well as rtl', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(uiDirectionSwitch(platform, false, 'rtl'), 'rtl', platform)
    assert.equal(uiDirectionSwitch(platform, false, 'ltr'), 'ltr', platform)
    assert.equal(uiDirectionSwitch(platform, false, null), null, platform)
  }
})

test('macOS keeps its system behaviour and an explicit switch is left alone', () => {
  assert.equal(uiDirectionSwitch('darwin', false, 'rtl'), null)
  assert.equal(uiDirectionSwitch('win32', true, 'rtl'), null)
  assert.equal(uiDirectionSwitch('linux', true, 'ltr'), null)
})

test('only the two direction words are understood, whatever the file holds', () => {
  assert.equal(parseStoredDirection('rtl'), 'rtl')
  assert.equal(parseStoredDirection(' ltr\r\n'), 'ltr')
  for (const garbage of ['', 'RTL', 'auto', '{"direction":"rtl"}', '\u0000rtl', 'rtl ltr']) assert.equal(parseStoredDirection(garbage), null, garbage)
  assert.equal(asDirection('rtl'), 'rtl')
  assert.equal(asDirection(1), null)
  assert.equal(asDirection(undefined), null)
})

test('reading the remembered direction never throws', () => {
  assert.equal(readStoredDirection('x', () => 'rtl'), 'rtl')
  assert.equal(readStoredDirection('x', () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }), null)
  assert.equal(readStoredDirection('x', () => 'garbage'), null)
})

test('the natural direction follows the language and script of the locale', () => {
  for (const locale of ['ar', 'ar-EG', 'ar_SA', 'he-IL', 'fa-IR', 'ur-PK', 'AR', 'ku-Arab', 'pa-Arab-PK']) assert.equal(naturalDirection(locale), 'rtl', locale)
  for (const locale of ['en-US', 'de', 'zh-CN', 'tr', '', 'ku-Latn', 'pa-IN']) assert.equal(naturalDirection(locale), 'ltr', locale)
})

test('the launched direction is the forced one, else the natural one, else unknowable', () => {
  const locale = () => 'ar-EG'
  assert.equal(launchedDirection('win32', false, 'ltr', locale), 'ltr')
  assert.equal(launchedDirection('linux', false, 'rtl', () => 'en-US'), 'rtl')
  assert.equal(launchedDirection('win32', false, null, locale), 'rtl')
  assert.equal(launchedDirection('linux', false, null, () => 'de'), 'ltr')
  assert.equal(launchedDirection('darwin', false, null, locale), null)
  assert.equal(launchedDirection('win32', true, null, locale), null)
})

test('a restart is needed only when the interface differs from the launched direction', () => {
  assert.equal(restartNeeded('ltr', 'rtl'), true)
  assert.equal(restartNeeded('rtl', 'ltr'), true)
  assert.equal(restartNeeded('rtl', 'rtl'), false)
  assert.equal(restartNeeded('ltr', 'ltr'), false)
  assert.equal(restartNeeded(null, 'rtl'), false)
})

test('a first launch in Arabic on an Arabic system asks for no restart, and an English system does', () => {
  const launched = (locale) => launchedDirection('win32', false, uiDirectionSwitch('win32', false, null), () => locale)
  assert.equal(restartNeeded(launched('ar-SA'), 'rtl'), false)
  assert.equal(restartNeeded(launched('en-US'), 'rtl'), true)
  assert.equal(restartNeeded(launched('ar-SA'), 'ltr'), true)
})

function memoryFiles(initial) {
  const files = new Map(initial)
  const writes = []
  return {
    writes,
    read: path => { if (!files.has(path)) throw new Error('missing'); return files.get(path) },
    write: (path, text) => { writes.push(text); files.set(path, text) }
  }
}

test('remembering the same direction twice writes the file once', () => {
  const files = memoryFiles([])
  assert.equal(rememberDirection('f', 'rtl', files), true)
  assert.equal(rememberDirection('f', 'rtl', files), false)
  assert.equal(rememberDirection('f', 'ltr', files), true)
  assert.deepEqual(files.writes, ['rtl', 'ltr'])
})

test('a garbage file is replaced and a failing write is swallowed', () => {
  const files = memoryFiles([['f', 'garbage']])
  assert.equal(rememberDirection('f', 'ltr', files), true)
  assert.equal(readStoredDirection('f', files.read), 'ltr')
  assert.equal(rememberDirection('f', 'rtl', { read: files.read, write: () => { throw new Error('read-only') } }), false)
})

test('the real files round trip through a temp directory', async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const directory = mkdtempSync(join(tmpdir(), 'novalist-direction-'))
  try {
    const file = join(directory, 'nested', 'ui-direction')
    assert.equal(readStoredDirection(file), null)
    assert.equal(rememberDirection(file, 'rtl'), true)
    assert.equal(readFileSync(file, 'utf8'), 'rtl')
    assert.equal(readStoredDirection(file), 'rtl')
    assert.equal(rememberDirection(file, 'rtl'), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a completed quit relaunches exactly once', async () => {
  const restart = new RestartAfterQuit()
  let relaunches = 0
  await restart.request(async () => { restart.quitStarting() })
  restart.willQuit(() => relaunches++)
  restart.willQuit(() => relaunches++)
  assert.equal(relaunches, 1)
})

test('a quit a close guard cancelled leaves nothing armed for a later ordinary quit', async () => {
  const restart = new RestartAfterQuit()
  let relaunches = 0
  await assert.rejects(restart.request(async () => { throw new Error('A window could not save its pending edits.') }))
  restart.quitStarting()
  restart.willQuit(() => relaunches++)
  assert.equal(relaunches, 0)
})

test('an ordinary quit never relaunches, and the request ends when the close flow does', async () => {
  const restart = new RestartAfterQuit()
  let relaunches = 0
  restart.quitStarting()
  restart.willQuit(() => relaunches++)
  assert.equal(relaunches, 0)
  await restart.request(async () => {})
  restart.quitStarting()
  restart.willQuit(() => relaunches++)
  assert.equal(relaunches, 0)
})

test('an AppImage is relaunched from the image, every other build as it was started', () => {
  const argv = ['/tmp/.mount_novalist/novalist', '--user-data-dir=/home/writer/profile', 'novalist://open']
  assert.deepEqual(relaunchOptions({ APPIMAGE: '/home/writer/Novalist.AppImage' }, argv),
    { execPath: '/home/writer/Novalist.AppImage', args: ['--user-data-dir=/home/writer/profile', 'novalist://open'] })
  assert.equal(relaunchOptions({}, argv), undefined)
  assert.equal(relaunchOptions({ APPIMAGE: '' }, argv), undefined)
})
