import type { CDPSession, Frame, TestInfo } from '@playwright/test'
import type { Harness } from '../harness'
import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'
import type { WritingMetrics } from './writingMetrics'
import type { FixtureScene } from './writingBook'
import type { ApplicationWritingImages } from './writingApplicationBook'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export async function applicationBuildIdentity(): Promise<Record<string, string>> {
  const assets = (await readdir('out/renderer/assets')).filter(name => /\.(js|css)$/.test(name)).map(name => join('out/renderer/assets', name))
  const runtime = (await readdir('out/renderer/editor')).filter(name => /\.(js|css|html)$/.test(name)).map(name => join('out/renderer/editor', name))
  const files = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', ...assets, ...runtime]
  const executable = process.platform === 'win32' ? 'Novalist.Backend.exe' : 'Novalist.Backend'
  const override = process.env.NOVALIST_BACKEND_PATH
  const backend = override && existsSync(override) ? override : join('..', 'Novalist.Backend', 'bin', 'Debug', 'net10.0', executable)
  const assemblies = (await readdir(dirname(backend))).filter(name => /^Novalist\..+\.dll$/.test(name)).sort()
  const backendNames = new Set(['Novalist.Backend.dll', 'Novalist.Backend.deps.json', 'Novalist.Backend.runtimeconfig.json', ...assemblies])
  const backendFiles = [backend, ...[...backendNames].map(name => join(dirname(backend), name))]
  const entries = [...files.map(file => [file.replaceAll('\\', '/'), file]),
    ...backendFiles.map(file => [`backend/${basename(file)}`, file])]
  const hashes = await Promise.all(entries.map(async ([name, file]) => [name, createHash('sha256').update(await readFile(file)).digest('hex')]))
  return Object.fromEntries(hashes)
}

export function expectedApplicationTyping(scenes: readonly FixtureScene[]): FixtureScene[] {
  return scenes.slice(0, 8).map((scene, index) => ({ id: scene.id,
    html: scene.html.replace(`w${index}x0`, `w${index}x0${'x'.repeat(10)}`) }))
}

export async function applicationProseIntegrity(frame: Frame, expected: readonly FixtureScene[]) {
  return frame.evaluate(scenes => {
    const editor = window as unknown as EditorWindow
    return scenes.map(scene => {
      const expectedRoot = document.createElement('div')
      expectedRoot.innerHTML = scene.html
      const paragraph = editor.getWritingSceneRoot(scene.id)?.querySelector('p')
      return { sceneId: scene.id,
        paragraphMatches: paragraph?.textContent === expectedRoot.querySelector('p')!.textContent,
        canonicalMatches: editor.serializeWritingScene(scene.id) === scene.html }
    })
  }, expected)
}

export async function applicationImageIntegrity(frame: Frame, expected: ApplicationWritingImages) {
  return frame.evaluate(async fixture => {
    const images = [...document.querySelectorAll<HTMLImageElement>('[data-writing-scene] img')]
    const decoded = await Promise.all(images.map(image => image.decode().then(() => true, () => false)))
    const sceneIds = images.map(image => image.closest('[data-writing-scene]')!.getAttribute('data-writing-scene'))
    return {
      expectedCount: fixture.sceneIds.length,
      count: images.length,
      decodedCount: images.filter((image, index) => decoded[index] && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0).length,
      dimensions: images.map(image => ({ width: image.naturalWidth, height: image.naturalHeight })),
      matches: images.length === fixture.sceneIds.length && new Set(sceneIds).size === fixture.sceneIds.length &&
        images.every((image, index) => decoded[index] && image.complete && image.naturalWidth === fixture.width && image.naturalHeight === fixture.height &&
          (image.getAttribute('data-nv-src') ?? image.getAttribute('src')) === fixture.src &&
          (image.currentSrc || image.src) === fixture.src && fixture.sceneIds.includes(sceneIds[index]!))
    }
  }, expected)
}

export async function recordApplicationProfile(session: CDPSession, stage: string, testInfo: TestInfo): Promise<void> {
  const { profile } = await session.send('Profiler.stop')
  const timings = new Map<number, number>()
  for (const [index, id] of (profile.samples ?? []).entries()) timings.set(id, (timings.get(id) ?? 0) + (profile.timeDeltas?.[index] ?? 0))
  const costs = profile.nodes.map(node => ({ function: node.callFrame.functionName, line: node.callFrame.lineNumber,
    selfMs: (timings.get(node.id) ?? 0) / 1000 })).sort((left, right) => right.selfMs - left.selfMs)
  console.log(JSON.stringify({ stage, costs: costs.slice(0, 25) }))
  await writeFile(testInfo.outputPath(`${stage}-profile.json`), JSON.stringify(profile))
}

interface InputProbe {
  samples: number[]; trusted: number; serviceCounts: number[]; serializationSamplesMs: number[]
  serializationCount: number; serializationTotalMs: number; serializationMaxMs: number
  readabilityRequests: number; scrollFrames: number; scrollPixels: number; scrolling: boolean
}
declare global { interface Window { applicationWritingProbe: InputProbe; applicationWritingRpcCounts: Record<string, number> } }

export async function observeApplicationTraffic(h: Harness): Promise<void> {
  await h.page.evaluate(() => {
    window.applicationWritingRpcCounts = {}
    window.novalistRpc.request = new Proxy(window.novalistRpc.request, {
      apply(target, receiver, args) {
        const method = String(args[0])
        window.applicationWritingRpcCounts[method] = (window.applicationWritingRpcCounts[method] ?? 0) + 1
        return Reflect.apply(target, receiver, args)
      }
    })
  })
}

export async function installApplicationProbe(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const probe: InputProbe = { samples: [], trusted: 0, serviceCounts: [], serializationSamplesMs: [],
      serializationCount: 0, serializationTotalMs: 0, serializationMaxMs: 0,
      readabilityRequests: 0, scrollFrames: 0, scrollPixels: 0, scrolling: false }
    window.applicationWritingProbe = probe
    const editor = window as unknown as EditorWindow
    const serialize = editor.serializeWritingScene.bind(editor)
    editor.serializeWritingScene = sceneId => {
      const start = performance.now()
      const result = serialize(sceneId)
      const duration = performance.now() - start
      probe.serializationCount++
      probe.serializationTotalMs += duration
      probe.serializationMaxMs = Math.max(probe.serializationMaxMs, duration)
      if (probe.serializationSamplesMs.length < 1024) probe.serializationSamplesMs.push(duration)
      return result
    }
    window.parent.addEventListener('message', event => {
      if (event.source !== window || typeof event.data?.novalistEditor !== 'string') return
      const message = JSON.parse(event.data.novalistEditor)
      if (message.type === 'readabilityRequest') probe.readabilityRequests++
    })
    document.addEventListener('beforeinput', event => {
      if (!(event instanceof InputEvent) || event.inputType !== 'insertText' || !event.isTrusted) return
      const start = performance.now()
      probe.trusted++
      requestAnimationFrame(() => {
        probe.samples.push(performance.now() - start)
        const state = (window as unknown as EditorWindow).writingServiceState()
        probe.serviceCounts.push(new Set([...state.visibleSceneIds, ...state.selectedSceneIds,
          ...[state.activeSceneId, state.composingSceneId].filter(id => id !== null)]).size)
      })
    }, true)
  })
}

export async function scrollApplicationWhileTyping(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const probe = window.applicationWritingProbe
    probe.scrolling = true
    const viewport = document.getElementById('editor-wrapper')!
    const scroll = (): void => {
      if (!probe.scrolling) return
      const before = viewport.scrollTop
      viewport.scrollBy(0, probe.scrollFrames % 120 < 60 ? 8 : -8)
      probe.scrollPixels += Math.abs(viewport.scrollTop - before)
      probe.scrollFrames++
      requestAnimationFrame(scroll)
    }
    requestAnimationFrame(scroll)
  })
}

export async function revealApplicationScene(frame: Frame, sceneId: string): Promise<number> {
  return frame.evaluate(async id => {
    const editor = window as unknown as EditorWindow
    const start = performance.now()
    editor.focusEditor()
    editor.revealWritingPoint({ sceneId: id, offset: 4, affinity: 'after' })
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    return performance.now() - start
  }, sceneId)
}

export async function applicationMemory(h: Harness): Promise<WritingMetrics & {
  writingPaneCount: number; rendererWorkingSetBytes: number; detachedSceneRoots: number
  processes: { type: string; workingSetBytes: number }[]
}> {
  const cdp = await h.page.context().newCDPSession(h.page)
  try {
    await cdp.send('HeapProfiler.collectGarbage')
    const heap = await cdp.send('Runtime.getHeapUsage')
    const dom = await cdp.send('Memory.getDOMCounters')
    const detached = await cdp.send('DOM.getDetachedDomNodes')
    const countSceneRoots = (node: { attributes?: string[]; children?: typeof detached.detachedNodes[number]['treeNode'][] }): number =>
      Number(node.attributes?.includes('data-writing-scene') ?? false) + (node.children ?? []).reduce((sum, child) => sum + countSceneRoots(child), 0)
    const detachedSceneRoots = detached.detachedNodes.reduce((sum, node) => sum + countSceneRoots(node.treeNode), 0)
    const counts = await h.page.evaluate(() => {
      const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe[title="editor"]')]
      return { writingPaneCount: document.querySelectorAll('[data-writing-pane]').length,
        editorRuntimeCount: frames.filter(frame => typeof (frame.contentWindow as EditorWindow).setWritingProjection === 'function').length,
        sceneRootCount: frames.reduce((count, frame) => count + frame.contentDocument!.querySelectorAll('[data-writing-scene]').length, 0) }
    })
    const processes = await h.app.evaluate(({ app }) => app.getAppMetrics().map(metric => ({
      type: metric.type, workingSetBytes: metric.memory.workingSetSize * 1024
    })))
    return { ...counts, heapUsedBytes: heap.usedSize, domNodeCount: dom.nodes,
      documentCount: dom.documents, eventListenerCount: dom.jsEventListeners,
      inputSamplesMs: [], inputP95Ms: null, serializationSamplesMs: [], processes, detachedSceneRoots,
      rendererWorkingSetBytes: processes.filter(process => process.type === 'Tab').reduce((sum, process) => sum + process.workingSetBytes, 0) }
  } finally { await cdp.detach() }
}

export async function applicationSearch(h: Harness): Promise<number> {
  return h.page.evaluate(async () => {
    const registry = window.novalistStores.project.getState().getWritingRegistry()!
    const start = performance.now()
    const captures = await window.novalist.captureWritingSearch!(registry.context)
    const snapshots = captures.flatMap(capture => capture.snapshots)
    const targets = snapshots.map(({ bookId, draftId, chapterGuid, sceneId }) => ({ bookId, draftId, chapterGuid, sceneId }))
    await window.novalistRpc.request('writingSearch/find', [{ expectedEpoch: registry.context.workspaceEpoch,
      targets, overrides: snapshots.map((snapshot, index) => ({ ref: targets[index], html: snapshot.html, hash: snapshot.hash, revision: snapshot.revision })),
      options: { pattern: 'w17x12', matchCase: true, wholeWord: true, useRegex: false } }])
    return performance.now() - start
  })
}
