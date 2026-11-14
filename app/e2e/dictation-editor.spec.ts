import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { launchApp, seedBook, type Harness } from './harness'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import { flushWriting, replaceWritingScene } from './writingTestActions'

type DictationHarness = Harness & { sceneId: string; otherSceneId: string }

type Fake = { gain: GainNode; context: AudioContext; calls: number; fail: boolean; formatFail?: boolean; hold: boolean;
  release?: () => void; stopped: boolean; languages: string[];
  warmup?: boolean; warmupCalls?: number; warmReady?: boolean; warmupId?: string;
  releaseWarmup?: () => void; rejectWarmup?: () => void; transcripts?: string[]; vocabulary?: string[];
  formatCalls?: number; constraints?: MediaStreamConstraints; warmAutomatic?: boolean }

test('Windows voice typing restores the caret and preserves a selected passage', async () => {
  const h = await setup()
  try {
    const editor = h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')
    await replaceWritingScene(h.page, h.sceneId, '<p>Before selected after.</p>')
    await editor.evaluate((element) => {
      const w = element.ownerDocument.defaultView as unknown as EditorWindow
      w.focusEditor()
      const range = element.ownerDocument.createRange()
      range.setStart(element.querySelector('p')!.firstChild!, 7)
      range.setEnd(element.querySelector('p')!.firstChild!, 15)
      w.getSelection()!.removeAllRanges(); w.getSelection()!.addRange(range)
    })
    await h.page.evaluate(() => {
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      navigator.mediaDevices.getUserMedia = async () => { throw new Error('Windows owns capture') }
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === 'dictation/providers') return [{ id: 'novalist.system', name: 'System', available: true,
          automaticDialogue: false, usesSystemPanel: true }] as T
        if (method === 'dictation/openSystemPanel') {
          const doc = document.querySelector<HTMLIFrameElement>('.editor-frame')!.contentDocument!
          if (doc.activeElement?.id !== 'editor') throw new Error('Editor did not regain focus')
          // Simulate OS text delivery without opening the actual microphone panel.
          doc.execCommand('insertText', false, ' spoken')
          return undefined as T
        }
        return original<T>(method, params)
      }
    })
    await h.page.getByRole('button', { name: 'Dictate', exact: true }).click()
    await expect(h.page.locator('.dictation-bar meter')).toHaveCount(0)
    await h.page.getByRole('button', { name: 'Open Windows voice typing', exact: true }).click()
    await expect(editor).toHaveText('Before selected spoken after.')
    await expect(h.page.locator('.dictation-bar')).toHaveCount(0)
  } finally { await h.close() }
})

test('Apple system dictation inserts German text at the caret without dialogue inference', async () => {
  const h = await setup()
  try {
    const editor = h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')
    await editor.click()
    await h.page.keyboard.type('Before. After.')
    await h.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home')
    for (let i = 0; i < 7; i++) await h.page.keyboard.press('ArrowRight')
    expect(await editor.evaluate((element) => element.ownerDocument.getSelection()?.anchorOffset)).toBe(7)
    await h.page.evaluate(() => {
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === 'dictation/providers') return [{ id: 'novalist.system', name: 'System', available: true,
          automaticDialogue: false, languages: [{ language: 'de', supported: true, installed: true }] }] as T
        if (method === 'dictation/transcribe') {
          const args = params as { language: string; audioBase64: string }
          if (args.language !== 'de' || !atob(args.audioBase64).startsWith('RIFF')) throw new Error('Invalid clip')
          return 'Hallo, sagte sie.' as T
        }
        if (method === 'dictation/format') throw new Error('Native dictation must not request dialogue inference')
        return original<T>(method, params)
      }
    })
    await h.page.getByRole('button', { name: 'Dictate', exact: true }).click()
    await expect(h.page.getByRole('button', { name: 'Start dictation', exact: true })).toBeDisabled()
    await h.page.locator('.dictation-bar').getByLabel('Spoken language', { exact: true }).selectOption('de')
    await h.page.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await h.page.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(editor).toHaveText('Before. Hallo, sagte sie. After.')
    await expect(h.page.getByText('Dialogue formatting failed for a clip.', { exact: false })).toHaveCount(0)
  } finally { await h.close() }
})

async function setup(): Promise<DictationHarness> {
  const h = await launchApp('nl-dictation-', {
    NOVALIST_BACKEND_PATH: resolve('../Novalist.Backend/bin/Debug/net10.0/Novalist.Backend' + (process.platform === 'win32' ? '.exe' : ''))
  })
  const book = await seedBook(h, { Chapter: ['First', 'Second'] }, 'Spec', false)
  await h.page.evaluate(async (chapter) => {
    await window.novalistStores.project.getState().openScene(chapter.guid, chapter.scenes[0].id)
  }, book.chapters[0])
  await h.page.locator('.writing-scope-segments').getByRole('button', { name: 'Scene', exact: true }).click()
  const scene = h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')
  await expect(scene).toHaveCount(1)
  await expect(scene).toHaveAttribute('data-writing-scene', book.chapters[0].scenes[0].id)
  await scene.click()
  await h.page.evaluate(() => {
    const context = new AudioContext()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    gain.gain.value = 0
    const destination = context.createMediaStreamDestination()
    oscillator.connect(gain).connect(destination)
    oscillator.start()
    const fake: Fake = { context, gain, calls: 0, fail: false, hold: false, stopped: false, languages: [] }
    ;(window as unknown as { dictationFake: Fake }).dictationFake = fake
    // Generated audio only: these tests never ask for the machine's microphone.
    navigator.mediaDevices.enumerateDevices = async () => [{ deviceId: 'studio-mic', kind: 'audioinput', label: 'Studio microphone', groupId: 'test' }] as MediaDeviceInfo[]
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      fake.constraints = constraints
      await context.resume()
      const stream = destination.stream.clone()
      const track = stream.getAudioTracks()[0]
      const stop = track.stop.bind(track)
      track.stop = () => { fake.stopped = true; stop() }
      return stream
    }
    const original = window.novalistRpc.request.bind(window.novalistRpc)
    window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
      if (method === 'dictation/providers') return [{ id: 'fake', name: 'Test speech', available: true,
        supportsWarmup: fake.warmup, supportsVocabulary: true, audioDestination: 'local test', formattingDestination: 'local test' }] as T
      if (method === 'dictation/warmUp') {
        fake.warmupCalls = (fake.warmupCalls ?? 0) + 1
        fake.warmupId = (params as { requestId: string }).requestId
        fake.warmAutomatic = (params as { automaticDialogue: boolean }).automaticDialogue
        await new Promise<void>((resolve, reject) => {
          fake.releaseWarmup = resolve
          fake.rejectWarmup = () => reject(new Error('Model loading failed or cancelled'))
        })
        fake.warmReady = true
        return undefined as T
      }
      if (method === 'dictation/cancel' && (params as { requestId: string }).requestId === fake.warmupId) {
        fake.rejectWarmup?.()
        return undefined as T
      }
      if (method === 'dictation/transcribe') {
        if (fake.warmup && !fake.warmReady) throw new Error('Audio arrived before warmup completed')
        const args = params as { audioBase64: string; language: string; vocabulary?: string[] }
        if (!atob(args.audioBase64).startsWith('RIFF')) throw new Error('Missing standalone WAV header')
        fake.languages.push(args.language)
        fake.vocabulary = args.vocabulary
        if (fake.fail) { fake.fail = false; throw new Error('Speech server unavailable') }
        if (fake.hold) await new Promise<void>((resolve) => { fake.release = resolve })
        fake.calls++
        return (fake.transcripts?.[fake.calls - 1] ?? (fake.calls === 1 ? 'Hello she said.' : 'Goodbye.')) as T
      }
      if (method === 'dictation/format' && fake.formatFail) throw new Error('Bad model output')
      if (method === 'dictation/format') {
        fake.formatCalls = (fake.formatCalls ?? 0) + 1
        return (fake.calls === 1
        ? [{ text: 'Hello.', kind: 'dialogue', newParagraph: true }, { text: 'she said.', kind: 'attribution', newParagraph: false }]
        : [{ text: 'Goodbye.', kind: 'dialogue', newParagraph: true }]) as T
      }
      return original<T>(method, params)
    }
  })
  return Object.assign(h, { sceneId: book.chapters[0].scenes[0].id, otherSceneId: book.chapters[0].scenes[1].id })
}
async function voice(page: Page, on: boolean): Promise<void> {
  await page.evaluate((enabled) => { (window as unknown as { dictationFake: Fake }).dictationFake.gain.gain.value = enabled ? 0.1 : 0 }, on)
}
async function start(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Dictate', exact: true }).click()
  await page.getByRole('button', { name: 'Start dictation', exact: true }).click()
  await expect(page.getByText('Listening…', { exact: false })).toBeVisible()
}

test('book vocabulary reaches recognition and plain mode keeps speech unquoted without running the formatter', async () => {
  const h = await setup()
  try {
    const character = await h.rpc<{ id: string }>('entities/create', ['character', 'Aeloria'])
    await h.rpc('entities/update', ['character', character.id, { surname: 'Großwald', notes: 'Private manuscript passage' }])
    await h.rpc('entities/updateLists', ['character', character.id, ['Aeli'], null, null])
    await h.page.evaluate(() => {
      const fake = (window as unknown as { dictationFake: Fake }).dictationFake
      fake.transcripts = ['Aeloria crossed Rübenbach.']
      fake.warmup = true
    })
    await h.page.getByRole('button', { name: 'Dictate', exact: true }).click()
    const bar = h.page.locator('.dictation-bar')
    await bar.getByLabel('Formatting', { exact: true }).selectOption('plain')
    await h.rpc('entities/create', ['location', 'Rübenbach'])
    await expect(bar.locator('textarea')).toHaveCount(0)
    await bar.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await expect.poll(() => h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.warmAutomatic)).toBe(false)
    await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.releaseWarmup?.())
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await bar.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')).toHaveText('Aeloria crossed Rübenbach.')
    const result = await h.page.evaluate(() => {
      const fake = (window as unknown as { dictationFake: Fake }).dictationFake
      return { terms: fake.vocabulary, formatCalls: fake.formatCalls ?? 0 }
    })
    expect(result.terms).toEqual(expect.arrayContaining(['Aeloria Großwald', 'Aeli', 'Rübenbach']))
    expect(result.terms).not.toContain('Private manuscript passage')
    expect(result.formatCalls).toBe(0)
    await bar.getByRole('button', { name: 'Close', exact: true }).click()
    await h.page.getByRole('button', { name: 'Dictate', exact: true }).click()
    await expect(bar.getByLabel('Formatting', { exact: true })).toHaveValue('plain')
    await h.rpc('entities/update', ['character', character.id, { surname: 'Sternwald' }])
    await bar.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await expect.poll(() => h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.warmupCalls)).toBe(2)
    await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.releaseWarmup?.())
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await bar.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect.poll(() => h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.vocabulary)).toContain('Aeloria Sternwald')
  } finally { await h.close() }
})

test('spoken controls start quoted dialogue and return to narration while ordinary command words remain prose', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => {
      (window as unknown as { dictationFake: Fake }).dictationFake.transcripts = [
        'New speaker. Hello. I need a new paragraph. Neuer Absatz. Er ging.'
      ]
    })
    await h.page.getByRole('button', { name: 'Dictate', exact: true }).click()
    const bar = h.page.locator('.dictation-bar')
    await bar.getByLabel('Formatting', { exact: true }).selectOption('plain')
    await bar.locator('summary').click()
    await bar.getByLabel('Spoken paragraph and speaker commands', { exact: true }).check()
    await bar.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await bar.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    const editor = h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')
    await expect(editor).toContainText('“Hello. I need a new paragraph.”')
    expect(await editor.innerText()).toMatch(/“Hello\. I need a new paragraph\.”\n+Er ging\./)
    expect(await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.formatCalls ?? 0)).toBe(0)
  } finally { await h.close() }
})

test('selected microphone is captured exactly and its input level responds before text arrives', async () => {
  const h = await setup()
  try {
    await h.page.getByRole('button', { name: 'Dictate', exact: true }).click()
    const bar = h.page.locator('.dictation-bar')
    await bar.locator('summary').click()
    await bar.getByLabel('Microphone', { exact: true }).selectOption('studio-mic')
    const level = bar.getByRole('meter', { name: 'Input level', exact: true })
    await expect(level).toBeVisible()
    await expect.poll(() => level.evaluate(element => (element as HTMLMeterElement).value)).toBe(0)
    await bar.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await expect(level).toBeVisible()
    await voice(h.page, true)
    await expect.poll(() => level.evaluate(element => (element as HTMLMeterElement).value)).toBeGreaterThan(0)
    const constraints = await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.constraints)
    expect(constraints?.audio).toMatchObject({ deviceId: { exact: 'studio-mic' } })
    expect(await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.calls)).toBe(0)
    await bar.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(level).toBeVisible()
    await expect.poll(() => level.evaluate(element => (element as HTMLMeterElement).value)).toBe(0)
    await expect(bar.getByLabel('Microphone', { exact: true })).toHaveValue('studio-mic')
  } finally { await h.close() }
})

test('spoken commands continue across clips without inserting an empty paragraph for a command alone', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => {
      (window as unknown as { dictationFake: Fake }).dictationFake.transcripts = ['New speaker.', 'Hello.', 'Again. New paragraph. She left.']
    })
    await h.page.getByRole('button', { name: 'Dictate', exact: true }).click()
    const bar = h.page.locator('.dictation-bar')
    await bar.getByLabel('Formatting', { exact: true }).selectOption('plain')
    await bar.locator('summary').click()
    await bar.getByLabel('Spoken paragraph and speaker commands', { exact: true }).check()
    await bar.getByRole('button', { name: 'Start dictation', exact: true }).click()
    const editor = h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')
    for (let clip = 1; clip <= 2; clip++) {
      await voice(h.page, true)
      await h.page.waitForTimeout(400)
      await voice(h.page, false)
      await expect.poll(() => h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.calls)).toBe(clip)
      if (clip === 1) {
        await expect(editor).toHaveText('')
        await expect(editor.locator('p')).toHaveCount(1)
      } else await expect(editor).toHaveText('“Hello.”')
    }
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await bar.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect.poll(() => editor.innerText()).toMatch(/^“Hello\. Again\.”\n+She left\.$/)
  } finally { await h.close() }
})

test('resuming a partly inserted command clip inserts only its remaining passages', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => {
      (window as unknown as { dictationFake: Fake }).dictationFake.transcripts = ['Before. New speaker. Hello. New paragraph. After.']
    })
    const editor = h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')
    await editor.evaluate(element => {
      const w = element.ownerDocument.defaultView as unknown as EditorWindow
      const insert = w.insertDictationText.bind(w)
      let calls = 0
      w.insertDictationText = (...args) => ++calls === 2 ? false : insert(...args)
    })
    await h.page.getByRole('button', { name: 'Dictate', exact: true }).click()
    const bar = h.page.locator('.dictation-bar')
    await bar.getByLabel('Formatting', { exact: true }).selectOption('plain')
    await bar.locator('summary').click()
    await bar.getByLabel('Spoken paragraph and speaker commands', { exact: true }).check()
    await bar.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await bar.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(editor).toHaveText('Before.')
    await editor.click()
    await h.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
    await bar.getByRole('button', { name: 'Resume pending speech at the caret' }).click()
    expect(await editor.innerText()).toMatch(/^Before\.\n+“Hello\.”\n+After\.$/)
    expect(await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.calls)).toBe(1)
  } finally { await h.close() }
})

test('an unavailable selected microphone reports the problem and can recover using System default', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async constraints => {
        const audio = constraints?.audio
        if (typeof audio === 'object' && audio.deviceId)
          throw new DOMException('Disconnected', 'OverconstrainedError')
        return capture(constraints)
      }
    })
    await h.page.getByRole('button', { name: 'Dictate', exact: true }).click()
    const bar = h.page.locator('.dictation-bar')
    await bar.locator('summary').click()
    await bar.getByLabel('Microphone', { exact: true }).selectOption('studio-mic')
    await bar.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await expect(bar.getByRole('alert')).toContainText('The selected microphone is unavailable')
    await expect(bar.getByRole('button', { name: 'Start dictation', exact: true })).toBeEnabled()
    await bar.getByLabel('Microphone', { exact: true }).selectOption('')
    await bar.getByRole('button', { name: 'Refresh microphones', exact: true }).click()
    expect(await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.stopped)).toBe(true)
    expect(await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.calls)).toBe(0)
    await bar.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await expect(bar.getByRole('alert')).toHaveCount(0)
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await bar.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')).toContainText('“Hello,” she said.')
  } finally { await h.close() }
})

test('model loading starts before any audio and capture continues while both models load', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => { (window as unknown as { dictationFake: Fake }).dictationFake.warmup = true })
    await start(h.page)
    await expect(h.page.getByText('Loading dictation models…', { exact: false })).toBeVisible()
    expect(await h.page.evaluate(() => {
      const fake = (window as unknown as { dictationFake: Fake }).dictationFake
      return [fake.warmupCalls, fake.calls]
    })).toEqual([1, 0])
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await expect.poll(() => h.page.locator('.dictation-bar meter').evaluate(element => (element as HTMLMeterElement).value)).toBeGreaterThan(0)
    await h.page.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(h.page.getByText('Pending clips: 1', { exact: false })).toBeVisible()
    expect(await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.stopped)).toBe(true)
    await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.releaseWarmup?.())
    await expect(h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')).toContainText('“Hello,” she said.')
    await expect(h.page.getByText('Loading dictation models…', { exact: false })).toHaveCount(0)
  } finally { await h.close() }
})

test('stopping before speech cancels model loading without showing a failure', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => { (window as unknown as { dictationFake: Fake }).dictationFake.warmup = true })
    await start(h.page)
    await h.page.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(h.page.getByText('Loading dictation models…', { exact: false })).toHaveCount(0)
    await expect(h.page.getByRole('alert')).toHaveCount(0)
    await expect(h.page.getByRole('button', { name: 'Start dictation', exact: true })).toBeEnabled()
    expect(await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.calls)).toBe(0)
  } finally { await h.close() }
})

test('a model loading failure retains already captured speech for retry', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => { (window as unknown as { dictationFake: Fake }).dictationFake.warmup = true })
    await start(h.page)
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.rejectWarmup?.())
    await expect(h.page.getByRole('alert')).toContainText('Dictation models could not be loaded')
    await expect(h.page.getByRole('meter', { name: 'Input level', exact: true })).toBeVisible()
    await expect.poll(() => h.page.getByRole('meter', { name: 'Input level', exact: true }).evaluate(element => (element as HTMLMeterElement).value)).toBe(0)
    await expect(h.page.getByText('Pending clips: 1', { exact: false })).toBeVisible()
    await h.page.evaluate(() => { (window as unknown as { dictationFake: Fake }).dictationFake.warmReady = true })
    await h.page.getByRole('button', { name: 'Resume pending speech at the caret' }).click()
    await expect(h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')).toContainText('“Hello,” she said.')
  } finally { await h.close() }
})

test('speech lands directly in the editor; stopping flushes the last clip without a preview', async () => {
  const h = await setup()
  try {
    const editor = h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')
    await editor.click()
    await h.page.keyboard.type('Before.')
    await start(h.page)
    await voice(h.page, true)
    await h.page.waitForTimeout(900)
    await voice(h.page, false)
    await expect(editor).toContainText('“Hello,” she said.', { timeout: 10000 })
    expect(await editor.innerText()).toMatch(/Before\.\n+“Hello,” she said\./)
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await h.page.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(editor).toContainText('“Goodbye.”', { timeout: 10000 })
    await expect(h.page.getByRole('button', { name: 'Start dictation', exact: true })).toBeEnabled()
    expect(await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.stopped)).toBe(true)
    await expect(h.page.getByRole('dialog', { name: /dictation|preview/i })).toHaveCount(0)
  } finally { await h.close() }
})

test('dictation starts at the caret between existing paragraphs and continues there', async () => {
  const h = await setup()
  try {
    const editor = h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')
    await editor.click()
    await h.page.keyboard.type('Before.')
    await h.page.keyboard.press('Enter')
    await h.page.keyboard.press('Enter')
    await h.page.keyboard.type('After.')
    await h.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home')
    await h.page.keyboard.press('ArrowUp')
    await start(h.page)
    await voice(h.page, true)
    await h.page.waitForTimeout(900)
    await voice(h.page, false)
    await expect(editor).toContainText('“Hello,” she said.', { timeout: 10000 })
    expect(await editor.innerText()).toMatch(/Before\.\s+“Hello,” she said\.\s+After\./)
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await h.page.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(editor).toContainText('“Goodbye.”', { timeout: 10000 })
    expect(await editor.innerText()).toMatch(/Before\.\s+“Hello,” she said\.\s+“Goodbye\.”\s+After\./)
  } finally { await h.close() }
})

test('pending speech keeps its place through proofing, page layout changes, and a moved caret', async () => {
  const h = await setup()
  try {
    const editor = h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')
    await h.page.evaluate(() => {
      const fake = (window as unknown as { dictationFake: Fake }).dictationFake
      fake.hold = true
      fake.formatFail = true
    })
    await replaceWritingScene(h.page, h.sceneId, '<p>Before the gap. After the gap.</p><p>Elsewhere.</p>')
    await editor.evaluate((element) => {
      const w = element.ownerDocument.defaultView as unknown as EditorWindow
      w.focusEditor()
      w.getSelection()!.setPosition(element.querySelector('p')!.firstChild!, 15)
    })
    await start(h.page)
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await h.page.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await h.page.waitForFunction(() => !!(window as unknown as { dictationFake: Fake }).dictationFake.release)
    await editor.evaluate((element) => {
      const w = element.ownerDocument.defaultView as unknown as EditorWindow
      w.setGrammarCheckEnabled(true)
      w.setGrammarIssues(JSON.stringify([{ offset: 0, length: 28, type: 'grammar',
        message: 'Fixture highlight', replacements: [] }]))
      w.setPageView(false)
      w.setGrammarIssues('[]')
      w.setPageView(true)
      // Editing elsewhere while a clip is processing must not redirect it.
      w.getSelection()!.setPosition(element.querySelectorAll('p')[1].firstChild!, 3)
    })
    await h.page.waitForTimeout(250)
    await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.release?.())
    await expect(editor.locator('p').first()).toHaveText('Before the gap. Hello she said. After the gap.')
    await expect(editor.locator('p').nth(1)).toHaveText('Elsewhere.')
    expect(await editor.evaluate((element) => {
      const selection = element.ownerDocument.defaultView!.getSelection()!
      return { text: selection.anchorNode!.textContent, offset: selection.anchorOffset }
    })).toEqual({ text: 'Elsewhere.', offset: 3 })
  } finally { await h.close() }
})

test('failed transcription keeps audio for retry and German quotation style reaches the editor', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(async () => {
      await window.novalistStores.settings.getState().update('global', { autoReplacementLanguage: 'de-guillemet' })
      ;(window as unknown as { dictationFake: Fake }).dictationFake.fail = true
    })
    await h.page.frameLocator('.editor-frame').locator('[data-writing-scene]').click()
    await start(h.page)
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await h.page.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(h.page.getByRole('alert')).toContainText('Transcription failed', { timeout: 10000 })
    await h.page.getByRole('button', { name: 'Resume pending speech at the caret' }).click()
    await expect(h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')).toContainText('»Hello«, she said.', { timeout: 10000 })
    expect(await h.page.evaluate(() => (window as unknown as { dictationFake: Fake }).dictationFake.languages)).toEqual(['de', 'de'])
  } finally { await h.close() }
})

test('a heard voice and its continued speech reach German paragraphs correctly across a pause', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(async () => {
      await window.novalistStores.settings.getState().update('global', { autoReplacementLanguage: 'de-guillemet' })
      const fake = (window as unknown as { dictationFake: Fake }).dictationFake
      fake.transcripts = [
        'Langsam öffnete sich das Tor vor den Mauern. Tretet hinein, werte neue Schüler, hörte man eine Stimme laut durch die Hallen rufen.',
        'Wir haben euch alle bereits erwartet. Langsam und vorsichtig begann Liam seinen Weg durch das große, hölzerne Tor.'
      ]
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === 'dictation/format') return (fake.calls === 1
          ? [{ text: 'Langsam öffnete sich das Tor vor den Mauern.', kind: 'narration', newParagraph: false },
            { text: '»Tretet hinein, werte neue Schüler«,', kind: 'dialogue', newParagraph: true },
            { text: 'hörte man eine Stimme laut durch die Hallen rufen.', kind: 'attribution', newParagraph: false }]
          : [{ text: 'Wir haben euch alle bereits erwartet.', kind: 'dialogue', newParagraph: false },
            { text: 'Langsam und vorsichtig begann Liam seinen Weg durch das große, hölzerne Tor.', kind: 'narration', newParagraph: true }]) as T
        return original<T>(method, params)
      }
    })
    const editor = h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')
    await editor.click()
    await start(h.page)
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await voice(h.page, false)
    await expect(editor).toContainText('hörte man eine Stimme laut durch die Hallen rufen.')
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await h.page.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(editor.locator('p')).toHaveText([
      'Langsam öffnete sich das Tor vor den Mauern.',
      '»Tretet hinein, werte neue Schüler«, hörte man eine Stimme laut durch die Hallen rufen. »Wir haben euch alle bereits erwartet.«',
      'Langsam und vorsichtig begann Liam seinen Weg durch das große, hölzerne Tor.'
    ])
    await expect(h.page.getByText('Dialogue formatting failed for a clip.', { exact: false })).toHaveCount(0)
  } finally { await h.close() }
})

test('a late result cannot write into another scene; pending speech resumes explicitly', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => { (window as unknown as { dictationFake: Fake }).dictationFake.hold = true })
    await h.page.frameLocator('.editor-frame').locator('[data-writing-scene]').click()
    await start(h.page)
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await h.page.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await h.page.waitForFunction(() => !!(window as unknown as { dictationFake: Fake }).dictationFake.release)
    await h.page.evaluate(async () => {
      const project = window.novalistStores.project.getState()
      const chapter = project.chapters[0]
      await project.openScene(chapter.guid, chapter.scenes[1].id)
      ;(window as unknown as { dictationFake: Fake }).dictationFake.release?.()
    })
    const other = h.page.frameLocator('.editor-frame').locator(`[data-writing-scene="${h.otherSceneId}"]`)
    await expect(other).toBeVisible()
    await expect(other).not.toContainText('Hello')
    await expect(h.page.getByText('Dictation paused because you left the scene.', { exact: false })).toBeVisible()
    await h.page.evaluate(async () => {
      const project = window.novalistStores.project.getState()
      await project.openScene(project.chapters[0].guid, project.chapters[0].scenes[0].id)
    })
    await h.page.frameLocator('.editor-frame').locator('[data-writing-scene]').click()
    await h.page.getByRole('button', { name: 'Resume pending speech at the caret' }).click()
    await expect(h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')).toContainText('“Hello,” she said.', { timeout: 10000 })
  } finally { await h.close() }
})

test('dictation preserves a selection, merges continued speech, supports undo, and rejects a replaced document', async () => {
  const h = await setup()
  try {
    const editor = h.page.frameLocator('.editor-frame').locator(`[data-writing-scene="${h.sceneId}"]`)
    await replaceWritingScene(h.page, h.sceneId, '<p>Keep these words.</p>')
    const inserted = await editor.evaluate((element) => {
      const w = element.ownerDocument.defaultView as unknown as EditorWindow
      w.focusEditor()
      const range = element.ownerDocument.createRange()
      range.selectNodeContents(element.querySelector('p')!)
      w.getSelection()!.removeAllRanges(); w.getSelection()!.addRange(range)
      return w.captureDictationAnchor('test') && w.insertDictationText('test', '“Hello.”', true, '', '“')
    })
    expect(inserted).toBe(true)
    await flushWriting(h.page)
    expect(await editor.evaluate((element) => {
      const w = element.ownerDocument.defaultView as unknown as EditorWindow
      return w.insertDictationText('test', 'Again.”', false, '”', '“')
    })).toBe(true)
    await expect(editor).toContainText('Keep these words.')
    await expect(editor).toContainText('“Hello. Again.”')
    await flushWriting(h.page)
    await h.page.keyboard.press('ControlOrMeta+z')
    await expect(editor).not.toContainText('Again.')
    await expect(editor).toContainText('Keep these words.')
    await expect(editor).toContainText('“Hello.”')
    expect(await editor.evaluate((element) => {
      const w = element.ownerDocument.defaultView as unknown as EditorWindow
      w.getSelection()!.setPosition(element.querySelector('p')!.firstChild!, 4)
      return w.captureDictationAnchor('stale')
    })).toBe(true)
    await replaceWritingScene(h.page, h.sceneId, '<p>Another scene.</p>')
    expect(await editor.evaluate((element) => {
      const w = element.ownerDocument.defaultView as unknown as EditorWindow
      return w.insertDictationText('stale', 'Wrong!', false, '', '')
    })).toBe(false)
    await expect(editor).toHaveText('Another scene.')
    await expect(editor).toHaveAttribute('data-writing-scene', h.sceneId)
  } finally { await h.close() }
})

test('formatting failure inserts the original transcript without stopping for a preview', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => { (window as unknown as { dictationFake: Fake }).dictationFake.formatFail = true })
    await start(h.page)
    await voice(h.page, true)
    await h.page.waitForTimeout(400)
    await h.page.getByRole('button', { name: 'Stop dictation', exact: true }).click()
    await expect(h.page.frameLocator('.editor-frame').locator('[data-writing-scene]')).toContainText('Hello she said.')
    await expect(h.page.getByText('Dialogue formatting failed for a clip.', { exact: false })).toBeVisible()
  } finally { await h.close() }
})

test('a speech tag after a pause repairs only the generated closing punctuation', async () => {
  const h = await setup()
  try {
    const editor = h.page.frameLocator('.editor-frame').locator(`[data-writing-scene="${h.sceneId}"]`)
    const result: string[] = []
    for (const [open, close, language, tag] of [['“', '”', 'en', 'she said.'], ['„', '“', 'de', 'sagte sie.']]) {
      await replaceWritingScene(h.page, h.sceneId, '<p><br></p>')
      const inserted = await editor.evaluate((element, { open, close, language, tag }) => {
        const w = element.ownerDocument.defaultView as unknown as EditorWindow
        w.focusEditor()
        w.getSelection()!.setPosition(element.querySelector('p')!, 0)
        return w.captureDictationAnchor('test') &&
          w.insertDictationText('test', open + 'Hallo.' + close, true, '', open) &&
          w.insertDictationText('test', tag, false, '', open, { close, language })
      }, { open, close, language, tag })
      expect(inserted).toBe(true)
      result.push(await editor.textContent() ?? '')
    }
    expect(result).toEqual(['“Hallo,” she said.', '„Hallo“, sagte sie.'])
  } finally { await h.close() }
})

test('denied microphone access returns to an actionable idle state', async () => {
  const h = await setup()
  try {
    await h.page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError') }
    })
    await h.page.getByRole('button', { name: 'Dictate', exact: true }).click()
    await h.page.getByRole('button', { name: 'Start dictation', exact: true }).click()
    await expect(h.page.getByRole('alert')).toContainText('Microphone access was denied')
    await expect(h.page.getByRole('button', { name: 'Start dictation', exact: true })).toBeEnabled()
  } finally { await h.close() }
})
