import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const defaultTimings = 'e2e/shard-timings.json'
const playwrightCli = 'node_modules/@playwright/test/cli.js'

/** Spec files (relative to the test directory) of a `--list --reporter=json` report. */
export function specFilesFromList(report) {
  const files = new Set()
  const visit = suite => {
    for (const spec of suite.specs ?? []) files.add(spec.file)
    for (const child of suite.suites ?? []) visit(child)
  }
  for (const suite of report.suites ?? []) visit(suite)
  return [...files].sort()
}

export function median(values) {
  if (values.length === 0) return 1
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * Longest-processing-time-first assignment: heaviest files first, each to the
 * currently lightest shard. Ties break on file name and shard index, so every
 * job computes the same plan from the same inputs. Files absent from the
 * timings get the median known duration.
 */
export function planShards(files, seconds, count) {
  const fallback = median(Object.values(seconds))
  const weight = file => seconds[file] ?? fallback
  const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }))
  const ordered = [...new Set(files)].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))
  for (const file of ordered) {
    const target = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best))
    target.files.push(file)
    target.seconds += weight(file)
  }
  for (const shard of shards) shard.files.sort()
  return shards
}

/** Per-file seconds of a project from Playwright JSON reports; the final attempt of each test counts. */
export function timingsFromReports(reports, project) {
  const seconds = {}
  for (const report of reports) {
    const totals = {}
    const visit = suite => {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          if (test.projectName !== project) continue
          const last = test.results?.at(-1)
          totals[spec.file] = (totals[spec.file] ?? 0) + (last?.duration ?? 0) / 1000
        }
      }
      for (const child of suite.suites ?? []) visit(child)
    }
    for (const suite of report.suites ?? []) visit(suite)
    for (const [file, total] of Object.entries(totals)) seconds[file] = Math.round(total * 100) / 100
  }
  return seconds
}

export function mergeTimings(existing, fresh) {
  const merged = { ...existing, ...fresh }
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)))
}

export function describeShard(index, count, shard) {
  return `E2E shard ${index}/${count}: ${shard.files.length} files, planned ${(shard.seconds / 60).toFixed(1)} min`
}

function readTimings(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).seconds ?? {} : {}
}

function listProjectFiles(project) {
  const result = spawnSync(process.execPath, [playwrightCli, 'test', '--list', '--project', project, '--reporter=json'], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024
  })
  if (result.status !== 0) throw new Error(`playwright --list failed: ${result.stderr || result.error}`)
  return specFilesFromList(JSON.parse(result.stdout))
}

const option = (argv, name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : fallback
}

function main(argv, env) {
  const project = option(argv, '--project', 'app')
  const timingsPath = option(argv, '--timings', defaultTimings)
  const refreshAt = argv.indexOf('--refresh')
  if (refreshAt >= 0) {
    const reports = argv.slice(refreshAt + 1).filter(arg => !arg.startsWith('--') && arg !== timingsPath && arg !== project)
    const seconds = mergeTimings(readTimings(timingsPath), timingsFromReports(reports.map(path => JSON.parse(readFileSync(path, 'utf8'))), project))
    writeFileSync(timingsPath, `${JSON.stringify({ project, seconds }, null, 2)}\n`)
    console.log(`Wrote ${Object.keys(seconds).length} file timings to ${timingsPath}`)
    return
  }
  const [index, count] = (option(argv, '--shard', '') ?? '').split('/').map(Number)
  if (!(count >= 1 && index >= 1 && index <= count)) throw new Error('usage: e2e-shard.mjs --shard i/N [--project app] [--timings file] | --refresh report.json...')
  const shards = planShards(listProjectFiles(project), readTimings(timingsPath), count)
  const lines = shards.map((shard, position) => describeShard(position + 1, count, shard))
  console.error(lines.join('\n'))
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### Planned shard durations\n\n${lines.map((line, position) => `- ${position + 1 === index ? '**' : ''}${line}${position + 1 === index ? '**' : ''}`).join('\n')}\n\n`)
  }
  console.log(shards[index - 1].files.map(file => `e2e/${file}`).join(' '))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2), process.env)
