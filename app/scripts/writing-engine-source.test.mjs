import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({ entryPoints: [fileURLToPath(new URL('../e2e/fixtures/writingEngineSource.ts', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external' })
const { scopeEditorSource } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const directory = new URL('../src/renderer/public/editor/', import.meta.url)
const files = (await readdir(directory)).filter(name => name.endsWith('.js'))

for (const fragments of [false, true]) {
  for (const name of files) test(`historical editor adapter compiles current ${name}, fragments=${fragments}`, async () => {
    const source = await readFile(new URL(name, directory), 'utf8')
    const transformed = scopeEditorSource(name, source, fragments)
    assert.doesNotThrow(() => new Script(transformed, { filename: name }))
  })
}

test('missing and duplicate editor seams fail with their source filename', async () => {
  assert.throws(() => scopeEditorSource('writing-zoom.js', 'function replacedZoom() {}'), /writing-zoom\.js/)
  const source = await readFile(new URL('writing-zoom.js', directory), 'utf8')
  assert.throws(() => scopeEditorSource('writing-zoom.js', source + source), /writing-zoom\.js/)
})
