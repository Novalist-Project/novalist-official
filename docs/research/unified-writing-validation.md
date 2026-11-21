# Unified writing production validation

Status: final verification in progress on `feat/unified-writing-workspace`.
This record covers the production editor integration, rather than the historical
test-only adapters in [the feasibility report](unified-writing-feasibility.md).
No merge or release is authorized by this record.

## Acceptance still open

- Unprofiled local/shared 100/500/1,000-scene performance matrix, with the original
  p95 below 50 ms and five-traversal memory thresholds unchanged.
- Final evidence reconciliation and local integration commits.

## Completed checks

| Check | Result |
| --- | --- |
| Node transport, stores, controllers and mounted component tests | 932 passed, one existing skip, zero failures (933 total) |
| Core | 4,193 passed; 23,359/23,359 covered lines |
| Backend | 2,468 passed; 16,586/16,586 covered lines |
| SDK | 61 passed; 30/30 covered lines |
| Sync Client | 210 passed; 105 Backend collaboration/peer integration cases also passed against the updated assembly |
| Python tooling | 103 tests, two existing skips, zero failures |
| Packaging helpers | 16 passed |
| Native continuous editor and feature parity | 54 passed against the unchanged editor engine |
| Inbox, annotation/import and ordered-act desktop corrections | Nine passed |
| Detached planning metadata refresh, split/tear-off and recovery | Six passed in the final integration run |
| Focus, split-pane navigation, scope and annotation regression after the focus correction | 19 passed |
| Final pagination, responsive layout, zoom, composition, dictation, focus and annotation regression | 86 passed |
| Navigation correction: Context, Binder, filters, mobile routes, scope, structure, planning and synopsis | 28 passed |
| Retained-DOM rendering, native selection/copy/undo, cold navigation, passive text and image geometry | Eight passed |
| Subsequent layout, focus, split-pane, annotation and proofing regression | 97 passed initially; its sole grammar-popup failure subsequently fixed and verified in the six-case run below |
| Final status proofing, offline grammar and context menu regression | Six passed on the rebuilt desktop application |
| Shared manuscript, rich editing, persistence, cursors and workspace transitions | 32 passed together on the final rebuilt application |
| TypeScript | Renderer, main and E2E projects passed |
| Builds | Desktop, mobile and normal Debug backend passed |
| Source checks | All eight repository checks passed |

The current default Playwright inventory contains 792 tests: 786 functional
cases and six integrated performance cases. The deduplicated functional ledger
records **761 passed, 25 skipped, zero failed and zero unrun**. These results
combine completed runs at successive implementation checkpoints; they are not
a claim that one final build ran all 786 cases. The 54 native cases and the
subsequent correction/regression runs are already included, not added again.
The checked-in [functional evidence ledger](unified-writing-evidence/functional-ledger.json)
retains each case's outcome, source log and any prerequisite skip reason.

The 25 unchanged prerequisite skips cover missing external extension builds,
relay checkouts/opt-in collaboration corpora and HTTPS trust fixtures, Steam,
Linux/macOS-specific behavior, unavailable supplied projects, packaged binaries,
and an opt-in online dictionary. They are not passes. Production shared-document
behavior is separately covered by the local TCP peer fixtures, backend tests,
recovery checks and the six-case performance matrix.

The Core, Backend and SDK coverage gates remain at 100%, with no new exclusions.
The optional dated-chapter command also passed 41 focused backend compatibility
tests against the updated Core assembly. The final native cases exercise rich
drag/drop, IME, annotation transfer, delayed actions, hidden scenes and writer undo.
Desktop regressions establish Inbox decisions/replies surviving subsequent edits,
external comment imports retaining pending prose, and undo of dated chapter
creation and movement into empty ordered acts.

The risk-based whole-branch review identified three integration defects: Binder
operations bypassing structural history, legacy annotation mutations leaving
canonical metadata stale, and mounted planning views missing metadata updates.
All three received fixes, focused regression coverage and independent review.
The final desktop checks passed their affected workflows. This review does not
substitute for the separate large-book performance gate.

Scale testing exposed a delayed focus callback redirecting typing into the other
pane, including when the host's active-element reference lagged behind actual
child-document focus. The callback now respects both. Six mounted-hook cases
cover focus ownership, text fields, Binder navigation and cleanup. Pagination
also retains unchanged page/prose nodes and moves only actual boundary changes;
three new regressions and a native geometry/caret/annotation/undo case cover it.
The final 86-case application selection and 54 native editor cases passed.

An earlier local500 benchmark passed the then-current 11 gates: 80 trusted inputs,
exact independent prose and full canonical markup in both panes, p95 14.6 ms,
page view, and five complete traversals retaining two runtimes and no detached
scene roots. Its raw metrics and completed Playwright report are retained as
historical evidence. Subsequent source changes invalidate reuse of that result
for final acceptance.

That aggregate attempt did not complete: local100 passed, but local1000 reached
the unchanged 600-second timeout after two of five traversals. All 80 typing
samples passed at p95 29.5 ms; that does not close performance acceptance. The
completed traversal heaps were 85,288,832 and 70,332,260 bytes with no detached
scene roots. The remaining shared cases were stopped before execution. The
navigation bottleneck was traced to unnecessary full-book context analysis and
whole-book React updates on scene changes. Context now reads only the current
scene unless character mention rows need chapter aggregates. The Binder updates
only affected row bodies; manuscript margins retain their subscriptions during
navigation. New mounted/read-count tests reproduced each regression before the
fix, and all 28 affected application cases passed afterward. Matched-character
timelines retain their existing book-wide scan. The changed build requires fresh
performance evidence rather than reusing the earlier build's passing cases.

The next million-word attempt recorded p95 52.9 ms and timed out after four
traversals. A bounded renderer profile identified layout and paint work. The
production canvas now lets Chromium skip rendering offscreen scene contents
while retaining every prose node, with visible first/last sections for native
keyboard selection and native scroll anchoring. Passive plain-text reads
temporarily render only a skipped scene when required to preserve `innerText`
semantics. Generation checks prevent old focus callbacks from reversing a newer
navigation. The eight native cases above cover selection in both directions,
the actual clipboard handler, formatting/undo, both-pane cold Find navigation,
rich and blank passive text, images and delayed focus. An injected-CSS diagnostic
reduced p95 from 50.8 to 9.9 ms, but is not acceptance evidence.

The image workload also now writes its original synthetic SVG into the temporary
project. Earlier data URLs were rewritten as invalid project-relative paths.
The final fixture verifies actual image URLs, native decoding, dimensions and
scene placement in both panes before typing and after traversal. This adds a
twelfth gate without changing any original timing, memory or correctness gate.
Historical results therefore do not establish the final decoded-image workload.

The final functional regression was a shipped proofing-popup race: a fixed
150 ms timer opened the popup during a 272 ms smooth scroll, whose next event
immediately hid it. Navigation now waits for scroll completion, with cancellable
no-motion and legacy-browser paths. Thirteen actual-script regressions and all
six affected desktop checks pass; the unchanged status test was not weakened.

The subsequent contained local1,000 run passed all twelve gates at p95 13.5 ms,
but shared1,000 timed out during initialization. Those earlier-build results
remain historical. Shared metadata capture now reads and indexes each file once
per operation, then revalidates its hash; four Sync tests cover draft identity,
schema validation, cancellation, stale hashes and concurrent changes. The 500-scene
startup diagnostic fell from 158 to 109 seconds before the final presence fix.
Initial shared bindings also preserve identical prose/page nodes. Collaborator
highlight styles and scroll listeners now exist only while a scene has remote
selections, instead of allocating one stylesheet for every passive scene.
Node tests cover 1,000 passive scenes, active cursors, cleanup and later arrivals.
These diagnostics are not substitutes for the frozen six-case acceptance matrix.

The next shared1,000 attempt reached editor readiness in 23.1 seconds, down from
332 seconds, and recorded p95 15.4 ms, but still timed out after three of five
traversals. A bounded post-edit navigation profile traced repeated full-editor
selection scans to React commits triggered by unchanged presence-health reports.
Healthy repeated reports now preserve store identity; genuine failure and recovery
still notify subscribers. Shared scene owners also reuse one stateless sanitizer
per window document, retaining independent scene documents and undo. Previously,
1,000 owners created 1,000 sanitizer documents. Two new regressions cover those
1,000-owner cases, failure transitions, independent edits/undo and unsafe markup.
All 933 Node tests were rerun after these changes, with 932 passes and one existing
skip. Earlier passing performance cases are not reused on this changed build.

That rebuilt shared1,000 case completed four traversals before the 600-second
test timeout. All 80 inputs recorded p95 15.7 ms; retained heap settled from
101,380,876 bytes to 98,615,044 / 98,766,196 / 98,863,264, with no detached roots.
A separate 100-jump diagnostic measured average focus 3.73 ms, reveal 2.52 ms,
and next-frame wait 7.42 ms; its document count was 11 instead of 1,010. These
diagnostics do not replace acceptance. The shared1,000 harness budget is now
900 seconds to include hosting/joining and all 5,000 sequential automated jumps.
The other cases retain 600 seconds. All twelve product assertions, the 50 ms p95
target, full workload and five-traversal memory bounds are unchanged. This is an
explicit test-budget correction, not a passing result for the timed-out run.

The reported workspace-changed toast came from invitation polling during a
workspace transition. Polling now waits during transitions and ignores obsolete
responses while retaining genuine current errors. Eight actual-module tests and
the native owner/peer open-host-join regression pass. The cursor-publication test
originally clicked the centre of a padded scene. Clicking inside its paragraph
passed three consecutive runs with the same publication, expiry and stale-session
assertions. The final rebuilt collaboration selection then passed all 32 cases
together in `production-shared-navigation-owners-e2e.log`.

The changed-source Aislop gate reported score 100 with no errors or fixable warnings. Eight nonfixable
production warnings concern large functions/files, an existing RPC parameter
list, and synchronous backend shutdown. These remain documented maintainability
limitations; rules and thresholds were not disabled. The mobile build
retains the existing large-bundle advisory, and the backend build reports the
existing obsolete `ChapterDetailInfo.Status` warning.

| Nonfixable production finding | Location |
| --- | --- |
| Eight RPC parameters | `Novalist.Backend/Rpc/ScenesRpc.Writing.cs`, `Activate` |
| 90-line coordinator | `Novalist.Backend/WritingMutationCoordinator.cs` |
| 478-line file | `app/src/main/index.ts` |
| 117-line hook | `app/src/renderer/src/shell/useWorkspaceWindow.ts` |
| 442-line file | `app/src/renderer/src/stores/manuscriptStore.ts` |
| 446-line file | `app/src/renderer/src/stores/shellStore.ts` |
| 842-line file | `app/src/renderer/src/stores/writingDocuments.ts` |
| Synchronous shutdown wait | `Novalist.Backend/BackendHost.cs` |

The changed-source scan also sees a ninth warning in an excluded local
diagnostic artifact. That artifact is not part of the delivery. These findings
require deliberate ownership/refactoring work rather than mechanical fixes.

The desktop feature uses one editor runtime per writing pane, retained canonical
scene ownership, and bounded expensive services. The six-case production matrix
must establish its latency and retained-memory acceptance; fast DOM tests and
diagnostic runs do not substitute for that measurement.

## Test suites

- `app/playwright.config.ts`: production application and retained editor regressions.
- `app/playwright.writing-native.config.ts`: shipped-editor continuous editing and
  feature parity in headless Chromium.
- `app/playwright.writing-research.config.ts`: historical experimental adapter
  suites, preserved separately from production acceptance.

The user explicitly authorized local Electron runs for this implementation.
Tests use synthetic projects or temporary copies of existing projects, temporary
profiles, and isolated clipboard handling. Original project files are not modified.
Performance measurements run separately from other builds and test processes.
See [test configuration notes](../../app/e2e/WRITING-TESTS.md).
