import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { seedWritingBook } from '../e2e/fixtures/writingBook.ts'
import { applicationBuildIdentity, applicationImageIntegrity, applicationProseIntegrity, expectedApplicationTyping } from '../e2e/fixtures/writingApplicationProbe.ts'

const fixtureBundle = await build({ entryPoints: [fileURLToPath(new URL('../e2e/fixtures/writingApplicationBook.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external' })
const { seedApplicationWritingBook } = await import(`data:text/javascript;base64,${Buffer.from(fixtureBundle.outputFiles[0].text).toString('base64')}`)

test('integrated performance fixture stores its original synthetic image as a project asset without changing prose or workload', async t => {
  const workDir = await mkdtemp(join(tmpdir(), 'novalist-performance-images-'))
  t.after(() => rm(workDir, { recursive: true, force: true }))
  const original = await seedWritingBook({ seed: async () => {} }, {
    sceneCount: 100, wordCount: 100_000, rich: true, longSceneWords: 25_000
  })
  const book = await seedApplicationWritingBook({ workDir }, 100)
  const originalSource = original.scenes[0].html.match(/src="([^"]+)"/)[1]
  const expectedSceneIds = original.scenes.filter((_, index) => index % 10 === 0).map(scene => scene.id)
  assert.equal(book.scenes[0].html.match(/src="([^"]+)"/)[1], 'novalist-project://nl/performance-image.svg')
  assert.equal(book.wordCount, 100_000)
  assert.equal(book.scenes.reduce((total, scene) => total + scene.wordCount, 0), 100_000)
  assert.deepEqual(book.images, { src: 'novalist-project://nl/performance-image.svg', width: 640, height: 360, sceneIds: expectedSceneIds })
  const asset = await readFile(join(book.root, 'performance-image.svg'))
  assert.deepEqual(asset, Buffer.from(originalSource.split(',')[1], 'base64'))
  for (const [index, scene] of book.scenes.entries()) {
    assert.equal(scene.html, original.scenes[index].html.replaceAll(originalSource, book.images.src))
    const stored = await readFile(join(book.root, 'Book', 'Drafts', 'default', 'Chapters', `chapter-${Math.floor(index / 25) + 1}`, scene.fileName), 'utf8')
    assert.equal(stored, `<!--nv v=1 id=${scene.id} -->\n${scene.html}`)
  }
})

test('performance prose oracle rejects canceled input, stale panes, and lost markup without returning prose', async t => {
  const book = await seedWritingBook({ seed: async () => {} }, { sceneCount: 100, wordCount: 100_000, rich: true })
  const expected = expectedApplicationTyping(book.scenes)
  assert.equal(expected.length, 8)
  const dom = new JSDOM('')
  const previous = { window: globalThis.window, document: globalThis.document }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  t.after(() => { Object.assign(globalThis, previous); dom.window.close() })
  const snapshots = new Map()
  const roots = new Map()
  dom.window.getWritingSceneRoot = id => roots.get(id)
  dom.window.serializeWritingScene = id => snapshots.get(id)
  const frame = { evaluate: (evaluate, values) => evaluate(values) }
  const install = scenes => {
    for (const scene of scenes) {
      const root = dom.window.document.createElement('section')
      root.innerHTML = scene.html
      roots.set(scene.id, root)
      snapshots.set(scene.id, scene.html)
    }
  }
  install(book.scenes.slice(0, 8))
  assert.ok((await applicationProseIntegrity(frame, expected)).every(scene => !scene.paragraphMatches && !scene.canonicalMatches))
  const typed = book.scenes.slice(0, 8).map(scene => {
    const root = roots.get(scene.id)
    const text = dom.window.document.createTreeWalker(root, dom.window.NodeFilter.SHOW_TEXT).nextNode()
    text.insertData(4, 'xxxxxxxxxx')
    return { id: scene.id, html: root.innerHTML }
  })
  install(typed)
  const result = await applicationProseIntegrity(frame, expected)
  assert.ok(result.every(scene => scene.paragraphMatches && scene.canonicalMatches))
  assert.ok(result.every(scene => Object.keys(scene).sort().join(',') === 'canonicalMatches,paragraphMatches,sceneId'))
  roots.get(expected[0].id).innerHTML = book.scenes[0].html
  assert.equal((await applicationProseIntegrity(frame, expected))[0].paragraphMatches, false)
  install(typed)
  snapshots.set(expected[1].id, typed[1].html.replace('<b>', '').replace('</b>', ''))
  assert.equal((await applicationProseIntegrity(frame, expected))[1].canonicalMatches, false)
  snapshots.set(expected[2].id, typed[2].html.replace('xxxxxxxxxx', 'xxxxxxxxx'))
  assert.equal((await applicationProseIntegrity(frame, expected))[2].canonicalMatches, false)
})

test('performance image oracle rejects undecoded, missing, displaced, duplicate, substituted and resized images without returning content', async t => {
  const dom = new JSDOM('')
  const previousDocument = globalThis.document
  globalThis.document = dom.window.document
  t.after(() => { globalThis.document = previousDocument; dom.window.close() })
  const fixture = { src: 'novalist-project://nl/performance-image.svg', width: 640, height: 360, sceneIds: ['scene-0', 'scene-10'] }
  const frame = { evaluate: (evaluate, values) => evaluate(values) }
  let decodeCalls = 0
  const install = () => {
    dom.window.document.body.innerHTML = fixture.sceneIds.map(id => `<section data-writing-scene="${id}"><p>Private text</p><img src="${fixture.src}"></section>`).join('')
    const images = [...dom.window.document.querySelectorAll('img')]
    for (const image of images) {
      Object.defineProperties(image, { complete: { configurable: true, value: true },
        naturalWidth: { configurable: true, value: 640 }, naturalHeight: { configurable: true, value: 360 } })
      image.decode = async () => { decodeCalls++ }
    }
    return images
  }
  install()
  const result = await applicationImageIntegrity(frame, fixture)
  assert.deepEqual(result, { expectedCount: 2, count: 2, decodedCount: 2,
    dimensions: [{ width: 640, height: 360 }, { width: 640, height: 360 }], matches: true })
  assert.equal(decodeCalls, 2)
  assert.equal(JSON.stringify(result).includes('Private text'), false)
  assert.equal(JSON.stringify(result).includes(fixture.src), false)
  for (const mutate of [
    images => { images[0].decode = async () => { throw new Error('Image decoding failed') } },
    images => { Object.defineProperty(images[0], 'complete', { value: false }) },
    images => { Object.defineProperty(images[0], 'naturalWidth', { value: 0 }) },
    images => { Object.defineProperty(images[0], 'naturalHeight', { value: 180 }) },
    images => { images[0].remove() },
    images => { images[0].src = 'novalist-project://nl/unexpected.svg' },
    images => { images[0].dataset.nvSrc = fixture.src; images[0].src = 'novalist-project://nl/unexpected.svg' },
    images => { images[0].closest('section').dataset.writingScene = 'unexpected-scene' },
    images => { images[0].closest('section').dataset.writingScene = 'scene-10' }
  ]) {
    mutate(install())
    assert.equal((await applicationImageIntegrity(frame, fixture)).matches, false)
  }
  install()
  dom.window.document.body.replaceChildren()
  assert.equal((await applicationImageIntegrity(frame, fixture)).matches, false)
})

test('performance build manifest fingerprints the selected backend and presentation assets without private paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'novalist-performance-manifest-'))
  const previousDirectory = process.cwd()
  const previousOverride = process.env.NOVALIST_BACKEND_PATH
  t.after(async () => {
    process.chdir(previousDirectory)
    if (previousOverride === undefined) delete process.env.NOVALIST_BACKEND_PATH
    else process.env.NOVALIST_BACKEND_PATH = previousOverride
    await rm(root, { recursive: true, force: true })
  })
  const directories = ['app/out/main', 'app/out/preload', 'app/out/renderer/assets', 'app/out/renderer/editor',
    'Novalist.Backend/bin/Debug/net10.0', 'private-override']
  for (const directory of directories) await mkdir(join(root, directory), { recursive: true })
  const assets = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', 'out/renderer/assets/index.js',
    'out/renderer/assets/index.css', 'out/renderer/editor/editor.html', 'out/renderer/editor/editor.js', 'out/renderer/editor/editor.css']
  for (const asset of assets) await writeFile(join(root, 'app', asset), asset)
  const executable = process.platform === 'win32' ? 'Novalist.Backend.exe' : 'Novalist.Backend'
  const backendFiles = [executable, 'Novalist.Backend.dll', 'Novalist.Backend.deps.json', 'Novalist.Backend.runtimeconfig.json',
    'Novalist.Core.dll', 'Novalist.Sdk.dll', 'Novalist.Sync.Client.dll']
  for (const name of backendFiles) {
    await writeFile(join(root, 'Novalist.Backend/bin/Debug/net10.0', name), `default:${name}`)
    await writeFile(join(root, 'private-override', name), `override:${name}`)
  }
  process.chdir(join(root, 'app'))
  delete process.env.NOVALIST_BACKEND_PATH
  const defaults = await applicationBuildIdentity()
  process.env.NOVALIST_BACKEND_PATH = join(root, 'private-override', executable)
  const overridden = await applicationBuildIdentity()
  const hash = text => createHash('sha256').update(text).digest('hex')
  for (const asset of assets) assert.equal(overridden[asset], hash(asset))
  for (const name of backendFiles) {
    assert.equal(defaults[`backend/${name}`], hash(`default:${name}`))
    assert.equal(overridden[`backend/${name}`], hash(`override:${name}`))
  }
  assert.deepEqual(Object.keys(overridden).sort(), [...assets, ...backendFiles.map(name => `backend/${name}`)].sort())
  assert.equal(JSON.stringify(overridden).includes(root), false)
  assert.equal(JSON.stringify(overridden).includes('private-override'), false)
  for (const assembly of ['Novalist.Core.dll', 'Novalist.Sync.Client.dll']) {
    await writeFile(join(root, 'private-override', assembly), `changed:${assembly}`)
    const changed = await applicationBuildIdentity()
    assert.deepEqual(Object.keys(changed).filter(key => changed[key] !== overridden[key]), [`backend/${assembly}`])
    assert.equal(changed[`backend/${assembly}`], hash(`changed:${assembly}`))
    await writeFile(join(root, 'private-override', assembly), `override:${assembly}`)
  }
  delete process.env.NOVALIST_BACKEND_PATH
  assert.deepEqual(await applicationBuildIdentity(), defaults)
})
