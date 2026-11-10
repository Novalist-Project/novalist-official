# Writing test suites

The default Playwright configuration runs shipped editor and application tests,
including `writing-cross-scene-editing`, scopes, search, structure, planning,
synopses, recovery, feature parity, and both production performance suites.
Existing `editor-*` and collaboration tests remain in that suite.

Fourteen architecture experiments use `fixtures/writingHarness.ts`, which rewrites
editor sources and compares rejected representations. They retain their original
assertions, including explicitly expected failures. Run them separately with:

```powershell
npx playwright test --config playwright.writing-research.config.ts
```

The original focused feasibility configuration and workflow also remain available.
Fragment and user-origin stylesheet experiments require their existing explicit
environment switches. Research results do not establish production acceptance.

`writing-performance.spec.ts` measures the integrated Electron application with
local and shared books, two writing panes, background work, and five traversals.
Its synthetic SVG images are real temporary project assets. Both panes must
decode every expected image at its original dimensions before typing and after
traversal; actual source URLs and scene placement are checked as well. Metrics
retain counts and dimensions, without prose or private project paths. This image
gate complements the existing latency, memory, exact-prose and runtime gates.
`writing-production-performance.spec.ts` isolates the shipped editor runtime.
Keep both results distinct; the application matrix is the release acceptance gate.
Profiling and diagnostic runs are not timing acceptance evidence. See the plan
and specification for the unchanged thresholds and fixture sizes.

The shared 1,000-scene case has a 900-second execution budget; other cases retain
600 seconds. The budget includes synthetic project creation, hosting/joining,
typing with background work, and 5,000 sequential cross-pane navigation commands.
The earlier 600-second shared run completed four traversals with stable heap and
typing p95 15.7 ms. A bounded diagnostic measured 13.7 ms average focus/reveal/next-
frame time. The increased harness budget allows the full endurance workload to
finish; all twelve product assertions, five traversals, 80 trusted inputs, the
50 ms p95 target, and the retained-heap limit remain unchanged. Both the earlier
timeout and the final results belong in the validation record.

Electron runs require the desktop consent described in the repository's AGENTS.md.
Test listing and typechecking do not activate windows.
