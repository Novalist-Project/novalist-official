# Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and `dev` and on pull requests
into them. Its jobs run in parallel:

| Job | What it runs |
| --- | --- |
| Tests Sdk and Core | `Novalist.Sdk.Tests` and `Novalist.Core.Tests` with coverage |
| Tests Backend | `Novalist.Backend.Tests` with coverage |
| Tests Sync.Client and repository tooling | `Novalist.Sync.Client.Tests` and the `tools/test_*.py` tests |
| Native window E2E | the Windows desktop window-chrome spec |
| 100% coverage | measures the cobertura results of the test jobs, publishes the badge on `main`, enforces 100% |
| Electron app checks | packaging and transport tests, typecheck, `tools/check-source.py`, desktop and mobile builds |
| E2E launch and credential-store smoke | the Linux launcher and keyring specs, once |
| E2E shard 1/4 to 4/4 | the `app` Playwright project against the real app, split by measured time |
| E2E writing-browser | the `writing-browser` project (headless Chromium, no backend or renderer build) |
| CI gate | fails unless every job above succeeded; the one check to require |

A new push to a pull request cancels that pull request's earlier run. Runs for
pushes to `main` and `dev` are never cancelled: the release workflow waits for the run
on the release commit.

## E2E shard balance

Playwright's own `--shard` splits by test count, which leaves the heavy specs clustered in a
few shards. The four shards instead take their spec files from
`app/scripts/e2e-shard.mjs`, which asks Playwright for the files of the `app` project
(so `testIgnore` and project filters apply), assigns them by longest-first greedy packing
using the per-file seconds in `app/e2e/shard-timings.json`, and prints the files of one
shard. Files missing from the timings get the median duration; every job computes the same
plan, and the shards together contain every file exactly once. Each shard prints its planned
minutes for all shards in the log and the job summary, so drift is visible.

Refresh the timings after adding heavy specs, or when the "E2E shard" jobs drift apart.
Download the `playwright-report/results.json` of each shard (the `playwright-traces-shard-N`
artifacts) and run, from `app/`:

```bash
node scripts/e2e-shard.mjs --refresh shard1/results.json shard2/results.json shard3/results.json shard4/results.json
```

Existing entries for files absent from the reports are kept. Stale timings only cost
balance, never coverage. The `writing-browser` project runs in its own job and is not
sharded.

## Flaky tests

In CI Playwright retries a failed test once (`retries` in `app/playwright.config.ts`;
locally there are no retries). A test that fails and then passes does not fail the run.
After every shard, `app/scripts/flaky-report.mjs` reads Playwright's JSON report and:

- writes a "Flaky tests" section (test, file, project, shard) to the job summary, or one
  line saying there were none;
- emits a warning annotation per flaky test, shown on the run page.

Each shard uploads its traces, including those of the failed first attempt, as
`playwright-traces-shard-N`. A test that keeps appearing in these summaries needs a fix.

## Stress branch

To check whether an intermittent E2E test is really fixed, or to reproduce it, push a
branch named `ci-stress/<anything>` that commits `.github/e2e-stress.json`:

```json
{"specs": ["e2e/focus-interactions.spec.ts"], "repeat": 20}
```

- `specs` (required): spec files relative to `app/`, one job per spec.
- `repeat` (optional, default 20, at most 500): how many times each spec runs.

The `E2E stress` workflow (`.github/workflows/e2e-stress.yml`) runs only for these
branches. Each spec runs with `--repeat-each <repeat> --retries 0` in the same environment
as a CI shard, so a single failing repetition fails its job. Traces are uploaded as
`playwright-traces-stress-N`. A missing file or an empty `specs` list fails immediately
with a message. The environment is shared with `ci.yml` through
`.github/actions/e2e-setup`, `.github/actions/e2e-run` and `eng/run-e2e-session.sh`.
