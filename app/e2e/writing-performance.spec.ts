import { expect, test, type CDPSession } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { dismissTour, enterWriting, launchApp, resizeWindow } from './harness'
import { seedApplicationWritingBook } from './fixtures/writingApplicationBook'
import { applicationBuildIdentity, applicationImageIntegrity, applicationMemory, applicationProseIntegrity, applicationSearch, expectedApplicationTyping, installApplicationProbe, observeApplicationTraffic, recordApplicationProfile, revealApplicationScene, scrollApplicationWhileTyping } from './fixtures/writingApplicationProbe'
import { writingEnvironment } from './fixtures/writingMetrics'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'
import { createApplicationPeer } from './fixtures/writingApplicationPeer'

for (const shared of [false, true]) for (const sceneCount of [100, 500, 1000]) {
  test(`integrated ${shared ? 'shared' : 'local'} writing ${sceneCount} scenes with two panes and background work`, async ({}, testInfo) => {
    test.setTimeout(shared && sceneCount === 1000 ? 900_000 : 600_000)
    const h = await launchApp('nl-writing-acceptance-')
    let peer: Awaited<ReturnType<typeof createApplicationPeer>> | undefined
    let profiler: CDPSession | null = null
    const diagnostic = process.env.NOVALIST_PERFORMANCE_PROFILE === '1' || process.env.NOVALIST_PERFORMANCE_DIAGNOSE === '1'
    const testStarted = Date.now()
    const phase = (stage: string, sample: number): void => { if (diagnostic) console.log(JSON.stringify({ stage, sample, elapsedMs: Date.now() - testStarted })) }
    try {
      const book = await seedApplicationWritingBook(h, sceneCount)
      await h.page.evaluate(root => window.novalistStores.project.getState().openProject(root), book.root)
      await dismissTour(h.page)
      await resizeWindow(h, 1500, 900)
      if (shared) peer = await createApplicationPeer(h, book)
      const started = Date.now()
      await enterWriting(h.page)
      await h.page.evaluate(async scene => {
        const project = window.novalistStores.project.getState()
        await project.openScene(scene.chapterGuid, scene.id)
        window.novalistStores.shell.getState().splitActivePane('row')
        await project.openSceneIn(window.novalistStores.shell.getState().activePaneId, scene.chapterGuid, scene.id)
      }, book.scenes[1])
      await expect(h.page.locator('iframe[title="editor"]')).toHaveCount(2)
      const frames = h.page.frames().filter(frame => frame.url().includes('/editor/editor.html'))
      for (const frame of frames) {
        await expect(frame.locator('[data-writing-scene]')).toHaveCount(sceneCount, { timeout: 120_000 })
        await expect(frame.locator('body'), 'page view remains enabled in each writing pane').toHaveClass(/\bpage-view\b/)
        await installApplicationProbe(frame)
        await frame.evaluate(() => (window as unknown as EditorWindow).setReadabilityEnabled(true))
      }
      const imagesBefore = await Promise.all(frames.map(frame => applicationImageIntegrity(frame, book.images)))
      await writeFile(testInfo.outputPath('integrated-writing-images-before.json'), JSON.stringify(imagesBefore, null, 2))
      expect(imagesBefore, 'every fixture image decodes at its original dimensions in both panes before typing').toEqual(
        [0, 1].map(() => ({ expectedCount: book.images.sceneIds.length, count: book.images.sceneIds.length,
          decodedCount: book.images.sceneIds.length, dimensions: book.images.sceneIds.map(() => ({ width: book.images.width, height: book.images.height })), matches: true })))
      const firstEditReadyMs = Date.now() - started
      await observeApplicationTraffic(h)
      console.log(JSON.stringify({ stage: 'ready', shared, sceneCount, firstEditReadyMs }))
      profiler = process.env.NOVALIST_PERFORMANCE_PROFILE === '1' ? await h.page.context().newCDPSession(h.page) : null
      if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start') }
      const debuggerSession = process.env.NOVALIST_PERFORMANCE_DIAGNOSE === '1' ? await h.page.context().newCDPSession(h.page) : null
      if (debuggerSession) {
        await debuggerSession.send('Debugger.enable')
        await debuggerSession.send('Debugger.setPauseOnExceptions', { state: 'all' })
        debuggerSession.on('Debugger.paused', async event => {
          console.log(JSON.stringify({ reason: event.reason, exception: event.data?.description,
            functions: event.callFrames.slice(0, 7).map(frame => frame.functionName) }))
          if (event.callFrames[0]?.functionName === 'applySharedWritingBatch') {
            const diagnostic = await debuggerSession.send('Debugger.evaluateOnCallFrame', { callFrameId: event.callFrames[0].callFrameId,
              expression: 'JSON.stringify({revision:session.revision,expected:change.expectedRevision,htmlEqual:session.html===change.beforeHtml,currentLength:session.html.length,beforeLength:change.beforeHtml.length,afterLength:change.afterHtml.length})', returnByValue: true })
            console.log(diagnostic.result.value)
          }
          await debuggerSession.send('Debugger.resume')
        })
      }
      const searchMs: number[] = [], navigationMs: number[] = []
      await scrollApplicationWhileTyping(frames[1])
      for (let sample = 0; sample < 80; sample++) {
        phase('input-start', sample)
        if (sample % 10 === 0) {
          phase('reveal-peer-start', sample)
          navigationMs.push(await revealApplicationScene(frames[1], book.scenes[Math.floor(sample / 80 * sceneCount)].id))
          phase('reveal-typing-start', sample)
          await revealApplicationScene(frames[0], book.scenes[Math.floor(sample / 10)].id)
          phase('reveal-done', sample)
        }
        const search = sample % 8 === 0 ? applicationSearch(h).then(duration => { searchMs.push(duration) }) : Promise.resolve()
        const remote = sample % 5 === 0 && peer ? peer.update() : Promise.resolve()
        await h.page.keyboard.type('x')
        phase('key-done', sample)
        await Promise.all([search, remote])
        phase('background-done', sample)
        await h.page.waitForTimeout(30)
        if (profiler && sample === 7) {
          await recordApplicationProfile(profiler, 'first-eight-inputs', testInfo)
          const progress = await Promise.all(frames.map(frame => frame.evaluate(() => ({
            samples: window.applicationWritingProbe.samples,
            serializations: window.applicationWritingProbe.serializationCount,
            serializationTotalMs: window.applicationWritingProbe.serializationTotalMs,
            longSceneNodes: document.querySelector('[data-writing-scene]')!.querySelectorAll('*').length,
            longSceneCharacters: document.querySelector('[data-writing-scene]')!.textContent!.length,
            pageWidth: document.querySelector('.nv-page')?.getBoundingClientRect().width,
            paragraphHeight: document.querySelector('.nv-page p')?.getBoundingClientRect().height
          }))))
          console.log(JSON.stringify({ stage: 'first-eight-inputs', progress, rpcCounts: await h.page.evaluate(() => window.applicationWritingRpcCounts) }))
          await writeFile(testInfo.outputPath('first-eight-inputs-progress.json'), JSON.stringify(progress, null, 2))
          await profiler.send('Profiler.start')
        }
      }
      await frames[1].evaluate(() => { window.applicationWritingProbe.scrolling = false })
      await h.page.evaluate(() => window.novalistStores.project.getState().getWritingRegistry()!.flush())
      const paneInputs = await Promise.all(frames.map(frame => frame.evaluate(() => window.applicationWritingProbe)))
      const inputs = { samples: paneInputs.flatMap(pane => pane.samples), trusted: paneInputs.reduce((count, pane) => count + pane.trusted, 0),
        serviceCounts: paneInputs.flatMap(pane => pane.serviceCounts), serializationSamplesMs: paneInputs.flatMap(pane => pane.serializationSamplesMs),
        serializationCount: paneInputs.reduce((count, pane) => count + pane.serializationCount, 0),
        serializationTotalMs: paneInputs.reduce((sum, pane) => sum + pane.serializationTotalMs, 0),
        serializationMaxMs: Math.max(...paneInputs.map(pane => pane.serializationMaxMs)),
        readabilityRequests: paneInputs.reduce((count, pane) => count + pane.readabilityRequests, 0),
        scrollFrames: paneInputs.reduce((count, pane) => count + pane.scrollFrames, 0),
        scrollPixels: paneInputs.reduce((count, pane) => count + pane.scrollPixels, 0) }
      if (peer) for (const frame of frames) await expect(frame.locator(`[data-writing-scene="${peer.sceneId}"]`)).toContainText('r'.repeat(peer.count()))
      const sorted = [...inputs.samples].sort((a, b) => a - b)
      const inputP95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1]
      console.log(JSON.stringify({ stage: 'typing', shared, sceneCount, inputP95Ms, samples: inputs.samples.length }))
      await Promise.all(frames.map(async frame => {
        const expected = expectedApplicationTyping(book.scenes)
        await expect.poll(() => applicationProseIntegrity(frame, expected), { message: 'all 80 typed characters and canonical scene markup survive in both panes' })
          .toEqual(expected.map(scene => ({ sceneId: scene.id, paragraphMatches: true, canonicalMatches: true })))
      }))
      if (profiler) {
        await recordApplicationProfile(profiler, 'typing', testInfo)
        await profiler.send('Profiler.start')
      }
      const rounds: Awaited<ReturnType<typeof applicationMemory>>[] = []
      for (let round = 0; round < 5; round++) {
        for (let index = 0; index < sceneCount; index++) {
          await revealApplicationScene(frames[index % 2], book.scenes[index].id)
          if (profiler && round === 0 && index === 49) {
            await recordApplicationProfile(profiler, 'navigation', testInfo)
            await profiler.detach()
            profiler = null
          }
        }
        await h.page.waitForTimeout(1000)
        rounds.push(await applicationMemory(h))
        console.log(JSON.stringify({ stage: 'traversal', shared, sceneCount, round: round + 1,
          heapUsedBytes: rounds[round].heapUsedBytes, detachedSceneRoots: rounds[round].detachedSceneRoots }))
      }
      const round2Heap = rounds[1].heapUsedBytes
      const maxLateTraversalHeap = Math.max(...rounds.slice(2).map(round => round.heapUsedBytes))
      const proseIntegrity = await Promise.all(frames.map(frame => applicationProseIntegrity(frame, expectedApplicationTyping(book.scenes))))
      const imagesAfter = await Promise.all(frames.map(frame => applicationImageIntegrity(frame, book.images)))
      const presentation = await Promise.all(frames.map(frame => frame.evaluate(() => ({
        pageView: document.body.classList.contains('page-view'), bodyClasses: document.body.className
      }))))
      const gates = { typing: inputP95Ms < 50, samples: inputs.trusted === 80 && inputs.samples.length === 80,
        images: imagesBefore.length === 2 && imagesAfter.length === 2 && [...imagesBefore, ...imagesAfter].every(pane => pane.matches),
        typedProse: proseIntegrity.length === 2 && proseIntegrity.every(pane => pane.length === 8 && pane.every(scene => scene.paragraphMatches && scene.canonicalMatches)),
        pageView: presentation.length === 2 && presentation.every(pane => pane.pageView),
        runtimes: rounds.every(round => round.editorRuntimeCount === 2 && round.writingPaneCount === 2),
        heap: maxLateTraversalHeap <= round2Heap * 1.1 + 8 * 1024 * 1024,
        documents: rounds.slice(2).every(round => round.documentCount <= rounds[1].documentCount),
        detachedRoots: rounds.every(round => round.detachedSceneRoots === 0),
        services: Math.max(...inputs.serviceCounts) < 10, readability: inputs.readabilityRequests > 0, scrolling: inputs.scrollPixels > 0 }
      const metrics = { environment: { ...await writingEnvironment(h.page), engine: 'electron',
        versions: await h.app.evaluate(() => process.versions) }, buildHashes: await applicationBuildIdentity(),
        presentation, proseIntegrity, images: { before: imagesBefore, after: imagesAfter },
        diagnostic, sceneCount, wordCount: book.wordCount,
        rpcCounts: await h.page.evaluate(() => window.applicationWritingRpcCounts),
        firstEditReadyMs, inputP95Ms, inputs, searchMs, navigationMs, rounds, gates,
        workload: { panes: 2, imagesPerPane: book.images.sceneIds.length, readability: true, searchRequests: searchMs.length, remoteUpdates: peer?.count() ?? 0, traversalRounds: 5, scenesPerTraversal: sceneCount } }
      const output = testInfo.outputPath('integrated-writing-metrics.json')
      await writeFile(output, JSON.stringify(metrics, null, 2))
      await testInfo.attach('integrated-writing-metrics', { path: output, contentType: 'application/json' })
      expect.soft(gates.samples, 'trusted input samples').toBe(true)
      expect.soft(gates.typedProse, 'typed prose and canonical markup survive in both panes').toBe(true)
      expect.soft(gates.images, 'all fixture images remain decoded at their original dimensions in both panes').toBe(true)
      expect.soft(gates.pageView, 'page view remains enabled in both panes').toBe(true)
      expect.soft(inputP95Ms, 'input to next frame p95').toBeLessThan(50)
      expect.soft(gates.runtimes, 'one heavy runtime per pane').toBe(true)
      expect.soft(maxLateTraversalHeap, 'retained heap rounds 3–5').toBeLessThanOrEqual(round2Heap * 1.1 + 8 * 1024 * 1024)
      expect.soft(gates.documents, 'no retained detached documents').toBe(true)
      expect.soft(gates.detachedRoots, 'no retained detached scene roots').toBe(true)
      expect.soft(gates.services, 'bounded active service scene set').toBe(true)
      expect.soft(gates.readability, 'real background readability requests').toBe(true)
      expect.soft(gates.scrolling, 'scrolling while typing').toBe(true)
    } catch (error) {
      if (profiler) await recordApplicationProfile(profiler, 'failure', testInfo)
      const inputs = await Promise.all(h.page.frames().filter(frame => frame.url().includes('/editor/editor.html'))
        .map(frame => frame.evaluate(() => window.applicationWritingProbe)))
      await writeFile(testInfo.outputPath('failed-input-metrics.json'), JSON.stringify({ shared, sceneCount, inputs }, null, 2))
      throw error
    } finally { try { await peer?.close() } finally { await h.close() } }
  })
}
