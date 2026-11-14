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
| E2E shard 1/4 to 4/4 | the Playwright suite against the real app, split with `--shard` |
| CI gate | fails unless every job above succeeded; the one check to require |

A new push to a pull request cancels that pull request's earlier run. Runs for
pushes to `main` and `dev` are never cancelled: the release workflow waits for the run
on the release commit.

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
