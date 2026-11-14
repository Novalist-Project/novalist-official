import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { findFlakyTests, renderAnnotations, renderSummary } from './flaky-report.mjs'

const script = fileURLToPath(new URL('./flaky-report.mjs', import.meta.url))

const spec = (title, file, status, attempts) => ({
  title,
  file,
  tests: [{ projectName: 'app', status, results: Array.from({ length: attempts }, () => ({})) }]
})

const report = {
  suites: [
    {
      title: 'alpha.spec.ts',
      file: 'alpha.spec.ts',
      specs: [spec('passes', 'alpha.spec.ts', 'expected', 1), spec('wobbles | sometimes', 'alpha.spec.ts', 'flaky', 2)],
      suites: [{
        title: 'group',
        file: 'alpha.spec.ts',
        specs: [spec('nested wobble', 'alpha.spec.ts', 'flaky', 2)]
      }]
    },
    {
      title: 'beta.spec.ts',
      file: 'beta.spec.ts',
      specs: [spec('breaks', 'beta.spec.ts', 'unexpected', 2), spec('skipped', 'beta.spec.ts', 'skipped', 0)]
    }
  ]
}

test('only tests that failed and then passed are flaky, including those in describe blocks', () => {
  const flaky = findFlakyTests(report, '2/4')
  assert.deepEqual(flaky.map(entry => entry.title), ['wobbles | sometimes', 'group > nested wobble'])
  assert.deepEqual(flaky[0], {
    title: 'wobbles | sometimes', file: 'alpha.spec.ts', project: 'app', attempts: 2, shard: '2/4'
  })
})

test('a report without flaky tests says so in one line', () => {
  const none = findFlakyTests({ suites: [report.suites[1]] }, '1/4')
  assert.equal(none.length, 0)
  assert.equal(renderSummary(none, '1/4'), '### Flaky tests (1/4)\n\nNo flaky tests in this shard.\n')
  assert.deepEqual(renderAnnotations(none), [])
})

test('the summary lists title, file and shard and escapes table separators', () => {
  const summary = renderSummary(findFlakyTests(report, '2/4'), '2/4')
  assert.match(summary, /2 test\(s\) failed and then passed on retry/)
  assert.match(summary, /\| wobbles \\\| sometimes \| alpha\.spec\.ts \| app \| 2\/4 \| 2 \|/)
})

test('annotations are warnings on the spec file with workflow-command escaping', () => {
  const [first] = renderAnnotations([{ title: '50% a,b\nc', file: 'x:y.spec.ts', shard: '3/4' }])
  assert.equal(first, '::warning file=app/e2e/x%3Ay.spec.ts,title=Flaky E2E test::50%25 a,b%0Ac (shard 3/4) failed and then passed on retry.')
})

test('the command line writes the summary file and warnings, and tolerates a missing report', () => {
  const directory = mkdtempSync(join(tmpdir(), 'novalist-flaky-'))
  try {
    const summaryFile = join(directory, 'summary.md')
    const run = () => spawnSync(process.execPath, [script, '--shard', '2/4'], {
      cwd: directory, env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile }, encoding: 'utf8'
    })
    const missing = run()
    assert.equal(missing.status, 0)
    assert.match(missing.stdout, /^::notice::No Playwright report/)
    mkdirSync(join(directory, 'playwright-report'))
    writeFileSync(join(directory, 'playwright-report', 'results.json'), JSON.stringify(report))
    const result = run()
    assert.equal(result.status, 0)
    assert.equal(result.stdout.trim().split('\n').length, 2)
    assert.match(result.stdout, /^::warning file=app\/e2e\/alpha\.spec\.ts/)
    assert.match(readFileSync(summaryFile, 'utf8'), /### Flaky tests \(2\/4\)/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
