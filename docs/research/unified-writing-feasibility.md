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

### Native Electron confirmation

The unchanged acceptance matrix was run on native Electron at clean revision
`111df9b28fdb1ea2426efe3c5cad5f383e2213ca`, after repairing the test launcher's
inherited Node-mode environment. Chrome was `148.0.7778.280`, viewport
1424 by 935 at DPR 1. The [directly verified native archive](writing-feasibility-electron.json)
contains the original three records, including environment and all samples.

| Scenes / words | Normal p95 | Page p95 | Typewriter p95 |
| --- | ---: | ---: | ---: |
| 100 / 100k | 13.1 ms | 95.5 ms | 37.0 ms |
| 500 / 500k | 24.9 ms | 265.0 ms | 165.0 ms |
| 1,000 / 1M | 42.0 ms | 454.0 ms | 325.7 ms |

The 27-case native run completed in 2.1 minutes with 22 positive passes, one
expected original diagnostic, and the four existing hard failures: continuous
page flow and the three scale cases. All five traversal rounds retained two
runtimes and passed the document/heap checks. Every record identifies clean
source digest `7d30068265216676978e6d2c17a0a669fcf860ce1c361eeb50088c5b811dbec0`.
Native normal-mode latency passes; page/typewriter costs still block rollout.
No instrumented timing is substituted for these acceptance samples.

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

### Bounded cost attribution (diagnostic, not acceptance)

The [marker-windowed profile records](writing-layout-profile-windowed.json) derive
from the unchanged [original full-stream archive](writing-layout-profile.json), a separate synthetic
100/1000-scene run at clean `b854f6fc913edf0c09786cf2caf04718b9f1862a`, source
digest `a60d044ec1a705acb37748979e6b1766a45ffe169e4b34e0e9dcdfb705eac8dc`.
This uses HeadlessChrome149.0.7827.55, two panes, the fixed25k-word long scene,
formatting/images/comments, and opt-in function telemetry plus eight CDP traces.
Raw traces remain local test artifacts. The saved summaries contain only opaque
identities, counts, durations and environment metadata.

Each mode has nine actual inputs at the beginning, middle and end, with scrolling
and DOM search,90ms between inputs and1100ms trailing observation. Acceptance
uses30samples, offset0, no1000ms mode-settle wait or90ms input gap; it also uses
a different native runtime/viewport. Here p95 of nine is the maximum sample.
Diagnostic p95 values (100/1000scenes) were normal94.7/95.1ms,
page30.3/1272.6ms, typewriter32.1/30.2ms, combined27.8/1276.0ms. They neither
replace the native table nor establish a latency pass or a comparable overhead
ratio. In particular, slower acceptance typewriter behavior remains unresolved.

The table reports totals across nine1000-scene inputs plus their delayed window.
Function totals include measured children and cannot be added together.

| Source/path | Observed cost/count | Interpretation |
| --- | --- | --- |
| `CompoundHistory.capture`, page | 1190ms aggregate,1145.6ms maximum;1013 rich-text updates and3111 mapping reads | Large first-window amplification is real in this trace, but not reproduced by the isolated probes below; do not call it steady-state per-input cost. |
| Scene paginator, page | 182.2ms over10passes;12scene passes/1364atoms;49.0ms selection restore | Dirty-scene repagination, not1000scenes per input. Full setup reflow is outside this timing window. Height reads alone account for2.2ms; function self-time includes packing, DOM work and uninstrumented browser calls. |
| Comment gutter, page / typewriter | 58.4/37.5ms;4100/3700anchor rects,4063/3667offscreen | Whole-book anchor work is measured, but is not the dominant observed capture spike. Card-height time is included separately in the archive. |
| Whole-root caret prefix, page / typewriter | 108.2/55.8ms;127.3M/83.4M UTF-16 characters copied | Repeated manuscript-prefix copying remains unbounded; status semantics were preserved. |
| Formatting selected blocks, page / typewriter | 94.8/59.3ms over24/16calls | Whole-root selection discovery also scales with book size. The prose-block counter includes this path, not just dimming. |
| Actual recenter, page / typewriter | 0.5/0.2ms over9calls each | Small in this spaced-input probe; insufficient to explain or dismiss native typewriter failures. |

Pipeline accounting now uses the validated writing-profile-start/end marker
interval, matching the active telemetry window. At1000scenes,
normal/page/typewriter/combined exclusive Script was355.4/1602.9/284.4/1583.4ms;
Layout27.5/207.1/25.2/202.7ms; Style4.7/13.7/6.1/19.4ms; and
Paint32.9/68.9/30.6/73.7ms. Page/combined maximum renderer tasks remain1150.4/
1153.2ms;184.951/179.797ms of layout intersects script. Their in-window Layout
event counts are66each. All events are clipped to the half-open marker interval:
straddling events contribute only positive overlap; layout counts and maximum
task time use that same overlap. Nested-layout duration is a per-thread union
of layout/script intersection. These are trace-event interval unions, not
CPU-sampling attribution or total compositor/GPU time.

The original pipeline totals included pre-start work: page920.921ms layout/
141.907ms style, combined952.241ms layout/140.949ms style. Those values are
excluded above; the other six streams' pipeline totals are unchanged. Historical
unrestricted values remain in the original archive and the derived archive's
explicit fullStreamPipeline fields. Function-cost rows already used active
telemetry and are unchanged. The large capture task remains in-window; clipping
does not establish its cause or remove the failed gates.

No benchmark was rerun. Eight original streams were reprocessed with algorithm
renderer-profile-mark-window-v2 at clean postprocessor revision
`03a80572e3acc633d8be75444d5187949a5611d7`, digest
`5912b2eafc4e3fe7ca9fb3952da7472e91fd656179f8c21ed09a566163e769b3`.
Original measurement/source provenance remains b854f6fc in every record;
postprocessing provenance is stored separately. The original full-stream archive
is byte-identical. Active-recording invariance also now covers real replacement,
flush, keyboard undo/redo and delayed work, with capture/mapping/observer spans
and exact disabled/enabled semantic snapshots required.

The [three bounded origin probes](writing-layout-capture-origin.json) identify
setup contamination without claiming to reproduce every traced spike. Page
setup leaves1000dirty scenes per pane; the fingerprint capture drains two
1000-scene batches, opening2000Yjs transactions with **zero content changes**.
The capture pane suppresses its own pre-transaction selection work, while the
other pane's listener still snapshots its active selection for each document,
including no-op transactions. Subsequent input batches touch one or two scenes.
The fresh-page first long-scene capture costs74.5ms, then12.1/13.3ms; after
normal-mode warmup, the first three are7.7/9.3/10.3ms. A third probe including
trace startup also remains bounded and leaves dirty sets empty at trace start.
Thus the original1146ms traced-only spike is unresolved, not proof that every
input captures the whole book. Extra read-only wrappers/listeners and their
individual source hashes are recorded for these diagnostic probes.

Primary modes retain disabled dimming/readability/grammar defaults. No focus
clearing ran there; zoom was1, with6–8resize callbacks totaling at most0.1ms and
no measured refresh/anchor-restore calls. A separately labelled enabled-service
probe observes one correction near613ms, readability near722ms, and grammar
submission near1811ms at1000scenes. Frontend mapping took0.6ms across both
requests; no backend analysis/result application was supplied. A1800ms wait
after input allows debounce rescheduling; this is not backend-service parity.

**Smallest next adaptation:** distinguish presentation-only wrapper mutations
from content dirtiness at the existing pagination/capture seam, preserving real
edits in mixed observer batches. Stop no-op layout work from opening scene
transactions or repeatedly snapshotting an unrelated pane's selection; first
prove zero content/history/publication changes and actual input preservation.
Then bound visible/pinned comment geometry and cache or otherwise resolve the
measured whole-root caret/formatting work without changing their semantics.
Do not replace the paginator or implement paper-gap representation in this step.
Continuous-page semantics and all existing failed performance gates remain open.

Retain separate scene documents and use scene-aware DOM positions plus grouped
writer-origin scene histories if this approach is continued. Do not migrate to
one book-wide Yjs document or use whole-scene snapshot replacement for shared
undo. The successful primitive is worth retaining as research; production
interfaces are not ratified until continuous pagination, bounded services,
history/selection edge cases and the full performance/host gate pass.

No changelog entry is appropriate: all changes are test/research assets.

## Presentation attribution refinement

The bounded follow-up keeps the existing scene paginator and one scene-owned
Y.Doc per scene. A shared test-only owned-move seam separates wrapper operations
from authored dirtiness in history and scoped publication capture. It processes
preexisting mutation records before each native wrapper move and retains real
character/attribute/child mutations in mixed or throwing operations. Native
selection restoration also covers page disable/re-enable. Transaction-keyed
pre-change selection snapshots remain; unrelated scene transactions no longer
read or restore a different selected scene. Native section/editor-container
endpoints share lookup with active context and publication capture.

Fifteen new browser regressions pass in both headless Chromium and Electron.
They cover rich prose/comments, an empty and long scene, two panes, native
forward/backward ranges and carets, delayed repagination, mixed/reentrant/throwing
mutations, IME deferral, nested transactions, container endpoints, exact semantic
state/HTML/raw block identities, connected owner identity, history and publication
counts. The unchanged focused editing suites also pass: 23 native cases;
22 headless cases plus one host skip, including the expected original diagnostic.
Two telemetry invariance cases and nine Node telemetry contracts pass; typecheck
and 509 Node tests pass with one existing skip. Both source freezes pass all eight
source doctors and staged aislop at score 100 with zero findings.

With 24 mounted scenes per pane, layout-only mode changes and delayed repagination
produce zero actual scene captures, markup reads, scoped publication serializer
calls, Yjs transactions, undo groups and publications. The next input captures
one scene, creates one changed transaction plus the existing Yjs formatting
cleanup transaction, and uses at most four author-pane markup reads. Peer rendering
acknowledges only its changed owner's clean-HTML baseline; that additional direct
HTML read is outside the scoped serializer counter. Unrelated selected scenes
have zero mapping reads, selection snapshots and restores.

The [native bounded diagnostic](writing-presentation-capture.json) uses clean
`9edf21793b58b35ab309291b57868b47aa34b872`, source SHA256
`4f929678ff390da1dd06770a4d83a9926b9abc4df216ca071ac4d6854e775ef5`.
Engine adaptation source is unchanged from `d2ed9207`; the later commit corrects
only the diagnostic's authored-publication oracle. Four modes each receive 30
actual native inputs, alternating panes and beginning/middle/end targets at
offset 0, with double-animation-frame timing, no mode settle/inter-input sleep,
1,000 scenes/1 million words and the fixed 25,000-word long scene. There are no profiler
body timers or CDP trace; ordinary existing capture telemetry remains enabled.
Exact HTML/Y.Text and last-publication checks run outside the timed input burst.
Each mode includes a 1,000 ms observation tail, unlike original no-tail acceptance;
that changes the state entering the following mode. Independent native frame
cadence was not collected. These timings establish no causal before/after speedup.
Same reference hardware/browser as the earlier native run: Ryzen 9 9950X3D,
32 logical CPUs, 32 GiB-class RAM, Windows 10.0.26300, Chrome 148.0.7778.280,
viewport 1424x935, DPR 1. The entire four-mode diagnostic passed in 34.5 seconds.

| Mode | First input ms | All 30 p95 ms | Subsequent 29 p95 ms |
| --- | ---: | ---: | ---: |
| Normal |87.4|54.2|27.5|
| Page |24.5|116.5|116.5|
| Typewriter |39.8|39.8|18.9|
| Page + typewriter |33.3|117.5|117.5|

Each mode change adds zero scoped serializations; the complete burst plus tail
adds exactly 15 per pane, 30 total, with exactly 30 authored history groups and
publications. An individual input observation may contain up to two scoped serializer
calls because the other pane's real pending debounce can complete in that window;
there is no whole-book serialization spike. Every mode's tail contains one real
pending publication, not presentation amplification. The separately preserved
[initial partial run](writing-presentation-capture-partial.json) at `d2ed9207`
failed an incorrect diagnostic assertion that this legitimate delayed publication
could not occur; it is not engine-failure or acceptance evidence.

Delayed layout/scroll remains a correctness concern: page-mode tails replace 24
wrappers per pane; combined tails replace 12/13. In normal/page/combined modes,
the last selected peer caret moves far outside the viewport during the 1,000 ms
observation tail, while typewriter-only endpoints agree. For example page caret
top 39.6 becomes -93797.4; combined 489.8 becomes 364225.8. No matched pre-change run
of this immediate-cadence diagnostic establishes causality. These observations
cannot be called stable visible layout or attributed solely to this fix.
No geometry repair or further benchmark was performed.

The [same-scene concurrency probe](writing-presentation-concurrency.json) executes
both baseline `5672bf79` and updated fixture bodies. A remote formatting render
still overwrites an uncommitted local edit in the same scene in both versions.
Processing pre-render records improves a simple insertion case that previously
left DOM/Y.Text divergent, but arbitrary pending-local/remote/IME interleavings
remain an unresolved correctness gate. Queued edits in another scene are
specifically covered and preserved. This is not an accepted concurrency policy.

The archived diagnostic is 33,752 bytes, SHA256
`0535de0380ae6a7e23f37778ea683b473815a7026b8f6cfa8b09ccb80c9c9564`;
filesystem byte/deep-equality checks preserve source/environment provenance and
all 120 samples. This is one bounded diagnostic, not the five-round heap/runtime
gate or a replacement for full native acceptance. Normal/page/combined p95 still
miss 50 ms here; existing continuous-page, latency, layout/scroll, concurrency and
production-parity gates remain closed. Next work needs a separately scoped
diagnosis of visible delayed layout/scroll and remaining whole-root work.

### Presentation review fix round 1

Independent review reproduced two attribution defects in the first refinement.
The test-only move classifier now matches exact ordered additions/removals and
requires the complete expected move sequence before suppressing records. Extra
same-node removal/reorder records and incomplete throwing operations remain
authored work. Publication acknowledgement now snapshots pending local dirtiness
before a peer render; an unpublished local revision keeps ownership instead of
being silently accepted as published. Focused tests require one capture/history
group/publication and matching DOM/Y.Text in both panes, while pure remote edits
retain zero echo publications and pure presentation retains zero content work.

The [matched viewport evidence](writing-presentation-viewport-review.json) uses
24 rich scenes/24,000 words with a 5,000-word long scene in both executable
pre-refinement baseline `5672bf79` and the updated test engine. Eight headless
passive cases and eight native passive cases compare normal/page modes, a visible
distant peer caret and an intentionally scrolled-away peer view. Four additional
native cases use a minimal normal-mode alternating-focus/reveal/edit trigger.
All matched peer logical endpoints, rectangles, scroll positions, heights and
scripted scroll-write sequences are exactly equal at every recorded checkpoint.

Passive earlier-scene editing keeps the native visible peer caret at top
489.859375 in normal mode (489.765625 in page mode) in both variants; intentionally
away controls stay at scrollTop 0 without peer scroll writes. The alternating
trigger then reproduces the bad viewport state in both variants. After the
intentional switch to a middle-scene caret, its input-frame top is already
6961.3125, outside the 935 px host viewport. A later existing `focus.restore`
callback changes scrollTop from 29745 to 45770, adding a -16025 px displacement
and leaving caret top -9063.6875. The callback is the unchanged 100 ms restore in
`clipboard-focus-events.js`; baseline/current callback sequence and values match.

This separates initial stable passive-peer state, reveal/layout displacement
after deliberate focus/target change, and the additional delayed scroll restore.
It establishes equivalent behavior for these matched triggers, not a complete
cause for every million-word displacement. The unchanged focus/scroll issue and
remaining reveal/layout instability belong in the next bounded geometry
diagnosis; no geometry source was changed or full benchmark rerun here.
Historical measurements retain their original revisions. All broad layout,
continuous-page, concurrency, production and performance gates stay closed.
