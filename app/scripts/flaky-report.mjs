import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const reportPath = 'playwright-report/results.json'

/** Tests that failed and then passed on a retry, from Playwright's JSON report. */
export function findFlakyTests(report, shard) {
  const flaky = []
  const visit = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status !== 'flaky') continue
        flaky.push({
          title: [...titles, spec.title].join(' > '),
          file: spec.file,
          project: test.projectName,
          attempts: test.results?.length ?? 0,
          shard
        })
      }
    }
    for (const child of suite.suites ?? []) visit(child, child.title === child.file ? titles : [...titles, child.title])
  }
  for (const suite of report.suites ?? []) visit(suite, suite.title === suite.file ? [] : [suite.title])
  return flaky
}

const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')

export function renderSummary(flaky, shard) {
  if (flaky.length === 0) return `### Flaky tests (${shard})\n\nNo flaky tests in this shard.\n`
  const rows = flaky.map(test =>
    `| ${cell(test.title)} | ${cell(test.file)} | ${cell(test.project)} | ${cell(test.shard)} | ${test.attempts} |`)
  return [
    `### Flaky tests (${shard})`,
    '',
    `${flaky.length} test(s) failed and then passed on retry. The run still passed; look at the failed first attempt in the uploaded traces.`,
    '',
    '| Test | File | Project | Shard | Attempts |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    ''
  ].join('\n')
}

const escapeData = value => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
const escapeProperty = value => escapeData(value).replaceAll(':', '%3A').replaceAll(',', '%2C')

export function renderAnnotations(flaky, appDirectory = 'app') {
  return flaky.map(test =>
    `::warning file=${escapeProperty(`${appDirectory}/e2e/${test.file}`)},title=${escapeProperty('Flaky E2E test')}::` +
    escapeData(`${test.title} (shard ${test.shard}) failed and then passed on retry.`))
}

function main(argv, env) {
  const shardIndex = argv.indexOf('--shard')
  const shard = shardIndex >= 0 ? argv[shardIndex + 1] : 'all'
  if (!existsSync(reportPath)) {
    console.log(`::notice::No Playwright report at ${reportPath}; flaky tests could not be listed.`)
    return
  }
  const flaky = findFlakyTests(JSON.parse(readFileSync(reportPath, 'utf8')), shard)
  const summary = renderSummary(flaky, shard)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`)
  else console.log(summary)
  for (const line of renderAnnotations(flaky)) console.log(line)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2), process.env)
