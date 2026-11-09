# Unified writing feasibility gate

Status: **BLOCKED for production integration**. This experiment does not authorize
Task 2. The current engine can support a shared editable root, protected scene
ownership, and grouped per-scene Yjs history, but this representation has not
passed continuous pagination, the complete latency matrix, or the full parity
inventory. This is evidence about the tested adapters, not proof that extending
the existing engine is impossible.

## Reproduce

From `app`, headless Chromium only:

```sh
npx playwright test --config playwright.writing-feasibility.config.ts --workers=1
```

The same spec can run through the normal desktop configuration on an authorized
isolated desktop. The dedicated config uses `NOVALIST_WRITING_ENGINE=electron`
for the small test-only Electron host and invokes the repository's desktop
permission guard. It creates a temporary profile and closes its launched process
through the existing teardown helper. It never opens the production application,
reads a user's book, or accesses the system clipboard. Local Electron evidence
is pending the controller's explicitly authorized run; no isolated CI result is
claimed here.

Controls: `NOVALIST_WRITING_OPTIMIZE=0` disables the incremental rendering,
content-visibility, pagination and scoped-capture adapters.
`NOVALIST_WRITING_SCOPED=0` keeps rendering adaptations but disables scoped
serialization/proofing maps. `NOVALIST_WRITING_DISTRIBUTION=extreme` restores the
25%-of-book first scene. All are test-only settings.

## Experiment boundaries

The harness serves the repository's real `editor.html` and classic scripts,
including native editing, formatting, annotations, pagination, and typewriter
behavior. It bundles the existing `SceneMarkup`, `updateRichText`, and Yjs
dependencies into a test-only adapter. Production source and navigation remain
unchanged. It does not transplant PR #64 or replace the engine.

One native editable root exists per pane. Each scene has a protected section,
its own existing-format rich text, its own `Y.Doc`/`Y.Text`, and its own
writer-origin `UndoManager`. A logical operation groups the affected managers;
the remote-insert fixture uses a second Yjs document and an encoded update.
Two pane views share these scene documents. Scoped projections hide retained
sections; this proves scope lifetime, not eviction/remount lifetime. Selections
use scene identity plus Yjs relative positions through the existing DOM mapper.

Formatting clips the logical range to each scene before invoking the existing
engine commands. Delete and paste preserve original containers, including empty
scenes. The copying check captures the real event payload in a `DataTransfer`,
without touching the system clipboard.

The incremental variant uses native text-node insertion only when a Yjs delta is
a simple insertion with matching marks; rich changes use the existing mapper.
CSS content visibility retains all scene DOM. A bounded pagination adaptation
groups scene paragraphs using the current engine's 48-em page budget. It restores
useful pages within long scenes but **forces a page break at each scene**. The
separate continuous-pagination assertion remains red; this is not accepted parity.

The final scoped variant changes two function signatures only in served test
copies: the existing clean serializer and proofing text mapper accept an explicit
root. The adapter maintains per-scene baselines, captures touched scenes, and adds
scene identity to the existing content-change publication. The actual publication
test failed before this change and passes with exact per-scene HTML afterwards.
There is no backend save/registry integration in this host.

## Evidence and measurements

Reference local machine: Windows build 10.0.26300, AMD Ryzen 9 9950X3D,
32 logical CPUs, approximately 31.6 GiB RAM, Node 26.7.0,
headless Chromium 149.0.7827.55. This is local evidence, not an isolated CI
reference-machine certification. Raw records retain versions, dimensions,
counts, samples and timings; they contain no story content or filesystem paths.

- [Original prototype measurements](writing-feasibility-baseline.json):
  100/500/1,000 scenes, 100k/500k/1M words, first scene 25% of total, two panes.
  These are **pre-paint diagnostics**, recorded at the first animation callback;
  page/typewriter arrays also include preceding modes. They are preserved as
  evidence of the initial attempt and must not be treated as final acceptance
  measurements.
- [Rendering-adapted measurements](writing-feasibility-render-optimized.json):
  fixed 25,000-word long scene, decoded 640x360 synthetic images, comments and
  rendered gutter cards, two panes, 30 independent samples per mode. Timing runs
  from the actual input event to the second animation callback, a conservative
  after-frame approximation. This includes the intervening layout/render cycle;
  it is not a hardware presentation timestamp.

| Scenes / words | Rendering-adapted normal p95 | Page p95 | Typewriter p95 |
| --- | ---: | ---: | ---: |
| 100 / 100k | 29.6 ms | 71.0 ms | 36.6 ms |
| 500 / 500k | 43.8 ms | 170.4 ms | 145.6 ms |
| 1,000 / 1M | 89.5 ms | 382.9 ms | 290.5 ms |

The controller fixed the main distribution at a 25,000-word long scene to avoid
conflating scene count with a 250,000-word single-scene stress case. The original
extreme measurements remain available and reproducible; no threshold changed.

Each matrix traverses every scene in both panes five times, yielding to an
animation frame at every scene. CDP garbage collection precedes each sample.
The original and rendering-adapted matrices kept two loaded editor runtimes,
stable document counts and heaps within round 2 +10% +8 MiB for rounds 3–5.
The largest rendering-adapted heap was about 31.8 MB after collection. DOM
document counters are a leak indicator; they do not prove that no detached root
is retained. Renderer resident memory and heap-snapshot dominators are not yet
measured.

The [final scoped-capture matrix](writing-feasibility-scoped.json) adds raw
serializer timing samples to distinguish remaining work from the earlier
whole-root serializer:

| Scenes / words | Scoped normal p95 | Page p95 | Typewriter p95 | Maximum single serialization |
| --- | ---: | ---: | ---: | ---: |
| 100 / 100k | 30.5 ms | 116.8 ms | 33.7 ms | 1.3 ms |
| 500 / 500k | 25.0 ms | 170.7 ms | 129.9 ms | 1.1 ms |
| 1,000 / 1M | 26.1 ms | 341.0 ms | 263.2 ms | 5.2 ms |

Normal-mode latency passed at all three scales after scoping. Page mode failed
at every scale; typewriter failed at 500 and 1,000 scenes. All five traversal
rounds completed in each case, with two runtimes, stable document counts and the
heap bound satisfied. These failures are not solely the unadapted whole-root
serializer: that path was replaced by touched-scene capture, and individual
serializer timings are much smaller than the slow frame samples. This is
partial attribution, not a complete CPU profile. Pagination, comment-gutter
geometry, scrolling and layout work remain candidates; their separate costs
have not yet been isolated.

The pre-review scoped run executed 16 tests: 11 experiment assertions passed, one
original-engine diagnostic failed as expected, and four hard gate cases failed
(continuous pagination plus the three scale tests). No acceptance assertion was
marked expected-failure or removed to obtain a green result.

### Review round 1

Independent review found native replacement, keyboard-history routing, and remote
selection defects that the original positive tests did not exercise. Source
`d5696b6718ebcedcf127956a93e8a21939939404` addresses those reproduced cases and adds
ten regressions. The tested native replacement/IME paths retain connected scene owners and the second
scene's suffix, keyboard undo/redo consume exactly one logical transaction, and
forward/backward selections plus independent pane carets survive remote updates
and scope changes. The new cases pass with both incremental and full-render
paths. The original diagnostic now validates setup before declaring expected
failure; the IME scope assertion checks the deferred visibility and exactly one
committed publication.

The previously committed scoped JSON was truncated tool output. It has been
regenerated directly from the intact originals, parsed and deep-compared. The
original baseline and rendering-adapted aggregates also deep-match their
originals. `archiveWritingMetrics.mjs` performs this packaging and verification
without passing sample data through model/tool-output text.

The [updated matrix](writing-feasibility-review-1.json) was run once after the
source commit, preserving all older measured records:

| Scenes / words | Normal p95 | Page p95 | Typewriter p95 | Maximum single serialization |
| --- | ---: | ---: | ---: | ---: |
| 100 / 100k | 29.7 ms | 76.3 ms | 42.3 ms | 1.4 ms |
| 500 / 500k | 30.0 ms | 270.1 ms | 223.6 ms | 1.2 ms |
| 1,000 / 1M | 42.1 ms | 496.5 ms | 354.5 ms | 1.3 ms |

The full 26-case run completed in 3.2 minutes: 21 experiment passes, one expected
original diagnostic, and four hard failures (continuous page flow and the three
scale cases). All five traversal rounds completed with two runtimes, stable
document counts and the heap bound satisfied. The measured source was clean;
each record carries its exact revision, explicit scoped/optimized adaptation
flags, distribution and the same relevant-source digest
`e259126678230c5aef3528cf8600a0df89052e7c886ed4da35f06823be31de97`.
The new archive is parsed and deep-equal to its three original metric files.

Normal-mode latency still passes at every scale. Page/typewriter costs and
continuous-page semantics still block the gate. The cost of retaining correct
selection/history is included in this new matrix; the earlier faster timings
are not substituted for it. Further work should target scene-aware layout and
bounded visible services within the existing engine. No engine replacement,
threshold change, or production rollout follows from these results.

Review round 2 corrected the replacement-event payload case: `insertReplacementText`
now reads plain text from `DataTransfer` when `data` is null. Its explicitly
event-dispatched regression verifies both live scene owners, exact peer text and
native undo/redo. Native typing and CDP composition remain separate real-input
checks. This replacement-only branch change did not trigger another headless
scale run; the table above remains attributed to its recorded source revision.

## Behavior assertions and remaining gates

Verified focused behavior includes actual mouse drag and backward keyboard
selection across scenes, copied prose, bold/italic/highlight/comments, protected
Backspace/Delete and paste, empty-scene retention, compound undo/redo through
scope changes, an independent replica insertion surviving local undo, two-pane
content agreement, scoped content publication, useful paragraph pagination,
and Chromium IME composition with a deferred scope change. The IME test uses
CDP's composition path, not only a synthetic composition event.

Initial RED results were real behavior failures: separate-iframe selection was
empty; boundary Backspace removed a scene; formatting undo left the second scene
italic; paste removed a scene; page layout made each long scene one page; content
publication lacked scene identity. The corresponding adapters retain their
assertions. Original separate-iframe selection is explicitly an expected-failure
diagnostic, never counted as a demonstrated shared-root capability.

The hard continuous-page test puts four words in two scenes and expects one
page. The bounded adapter produces two. Supporting arbitrary page boundaries
across scenes needs scene fragments with stable logical ownership, or a different
page presentation strategy that preserves existing semantics. Neither has been
silently substituted here.

The [complete parity inventory](unified-writing-parity.md) covers all 77
`EditorWindow` methods plus the specification's host features. Its existing tests
are regression seeds, not evidence that every feature works in this adapter.
Unimplemented/unverified rows remain rollout blockers, including host commands,
extension active-scene context and passive reads, failed/delayed durable saves,
compound recovery, full proofing/readability services, structural inverses,
search/replace transactions, combined remote/composition interleavings,
and mobile/project round trips. The benchmark performs DOM text
search between inputs and exercises real editor timers/comment layout; it does
not complete actual backend proofing analyses concurrently. That acceptance
workload remains unproven.

## Provisional adapter decision

Retain separate scene documents and use scene-aware DOM positions plus grouped
writer-origin scene histories if this approach is continued. Do not migrate to
one book-wide Yjs document or use whole-scene snapshot replacement for shared
undo. The successful primitive is worth retaining as research; production
interfaces are not ratified until continuous pagination, bounded services,
history/selection edge cases and the full performance/host gate pass.

No changelog entry is appropriate: all changes are test/research assets.
