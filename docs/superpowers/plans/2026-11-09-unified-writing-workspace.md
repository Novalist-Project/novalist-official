# Unified Writing Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the duplicate prose editors with one continuous writing experience, add ordered act/chapter/scene planning, and retain existing editing capabilities at large-book scale.

**Architecture:** Extend the existing editor with one runtime per pane and a shared scene-document registry, independent of scope and service mounts. Writer-scoped transactions own undo and recoverable changes; scene files and collaborative documents retain their identities. Reuse metadata for Structure and existing planning views.

**Tech Stack:** Electron/React/TypeScript, existing JavaScript contenteditable editor, Zustand, .NET 10 JSON-RPC/Core services, existing Yjs collaboration, Node/JSDOM and xUnit/Playwright tests. No replacement editor or new runtime dependency is pre-approved.

**Spec:** [Unified writing workspace design](../specs/2026-11-09-unified-writing-workspace-design.md).
**ADR:** [One continuous writing surface](../../adr/0008-unified-writing-surface.md).
**Status:** Implementation authorized on 2026-11-09. Task 1 is in progress and remains a mandatory feasibility gate; later tasks are pending its result.

## Global Constraints

- New panes default to Manuscript; each pane independently remembers Scene/Chapter/Manuscript scope.
- No scene titles in the writing canvas/margin; retain titles as organizational metadata.
- Cross-scene selection/copy/format/delete/find/replace and undo survive scope/viewport changes.
- Acts are optional ordered groups of consecutive chapters; never create interleaved membership.
- Synopses start collapsed below word count; remember local expansion and provide master visibility.
- Keep fixed paragraph-style access and add explicitly declared transient quick-edit access.
- Extend the existing editor; preserve separate scene files, mobile behavior, and project compatibility.
- Acceptance: 1,000 scenes / 1 million words; typing-response p95 under 50 ms on recorded reference hardware.
- One heavyweight editor runtime per writing pane; no runtime accumulation on traversal.
- Five traversal rounds: retained heap in rounds 3–5 stays within 10% + 8 MiB of round 2 under equivalent idle/GC conditions.
- Preserve the full feature inventory and existing planning tools from the spec; no silent parity cuts.
- Preserve 100% Core/SDK/Backend line coverage, correct en/de/zh-CN strings, and design tokens.
- Never log prose, titles, summaries, search strings, or paths. Benchmarks use synthetic content.
- Electron E2E runs only on isolated CI/dedicated desktops. Never set `NOVALIST_E2E_ALLOW_DESKTOP=1` locally to bypass isolation.
- Recheck local main/dev and PR #64 revisions first. Do not automatically merge PR #64 or transplant its iframe architecture.
- Each task includes focused failing tests, minimal implementation, passing focused checks, and one focused commit. Do not commit unrelated workspace files.

## Review Focus

1. IME/selection during scope changes or remote refresh: no lost characters, moved caret, or premature disposal. Tasks 3 and 5.
2. Half-completed multi-file writes, process interruption, stale hashes, or a refusing window: recover all affected content and keep failures retryable. Task 4.
3. Duplicate annotation IDs and multi-scene undo after a remote edit: correct scene ownership; never restore over another writer's work. Tasks 3, 5, and 7.
4. Empty/filter-limited books, unassigned/legacy acts, and moves across hidden items: preserve reading order and resolve destinations against the full manuscript. Tasks 6, 7, and 11.
5. Two panes/windows and project/draft switches during searches: exact match navigation, stable scope/history, no dirty-content leak into the next workspace. Tasks 2, 8, 10, and 12.

## File responsibilities and dependency order

Keep production code in existing editor/store/service areas; the HTML prototype
is a reference only. The listed new modules are small responsibility boundaries,
not a second framework. Task 1 may refine their interfaces; update the shared
contracts and dependent tasks together before production work if it does.

| Responsibility | New module(s) | Existing integration |
| --- | --- | --- |
| Scene identity, projections, live document ownership | `app/src/renderer/src/views/editor/writingTypes.ts`, `stores/writingDocuments.ts`, `stores/writingProjection.ts` | projectTypes, projectEditorActions, pendingWrites |
| One scene-aware editing surface | `public/editor/writing-document.js`, `writing-selection.js`, `writing-transactions.js` | editor runtime/content/typing/formatting/annotations |
| Host/pane adapter and compact margin | `views/editor/UnifiedWritingEditor.tsx`, `WritingSceneMargin.tsx`, `unified-writing.css` | EditorFrame, MainArea, SceneSynopsisField |
| History and save ownership | `stores/writingHistory.ts`, `stores/writingPersistence.ts` | sceneWriteQueue, projectPersistence, workspace coordination |
| Recoverable compound mutations | `Novalist.Core/Services/WritingOperationJournal.cs`, `Novalist.Backend/WritingMutationCoordinator.cs`, `Rpc/WritingRpc.cs` | WorkspaceCoordinator, scene conflict and shared-write recovery |
| Acts and structure | `Novalist.Core/Services/ActStructureService.cs`, `ManuscriptStructureService.cs`, `Models/WritingStructure.cs` | ProjectService, SceneSplitService, ActData/draft lists |
| Shared transaction history/services | `collaboration/SharedWritingHistory.ts`, `views/editor/writingServiceScheduler.ts` | SharedEditorSession, sharedDocuments, CollaborativeScene |
| Dirty-aware search | `views/editor/writingSearch.ts`, `Novalist.Core/Models/WritingSearch.cs`, `Rpc/WritingSearchRpc.cs` | FindReplaceService, HtmlSearchText, FindReplaceDialog |
| Ordered planning | `views/manuscript/StructureBoard.tsx`, `StructureChapter.tsx`, `structureProjection.ts`, `structure.css` | project metadata, existing planning modes |
| Scope/layout migration | `stores/writingLayoutMigration.ts` | shellTypes, shellPanes, layoutStore, modes, commands |

Paths in the table beginning `public/`, `views/`, `stores/`, or
`collaboration/` are under `app/src/renderer/` (`public/`) or
`app/src/renderer/src/` (the others).

Dependencies: 1 → 2 → 3 → 4 → 5. Task 6 can follow 2; Task 7 needs 4–6.
Tasks 8–10 use 2–5; Task 11 uses 6–7 and 10; Task 12 integrates 8–11;
Task 13 validates the complete system. Do not expose a partially capable
replacement in normal desktop navigation.

## Shared interface contracts

Define these in Task 2; use the same names in later tasks.

- `SceneRef = { bookId: string; draftId: string; chapterGuid: string; sceneId: string }`.
- `WritingScope = 'scene' | 'chapter' | 'manuscript'`.
- `WritingPoint = { sceneId: string; offset: number; affinity: 'before' | 'after' }`;
  offset is UTF-16 in the canonical searchable prose text, excluding chrome.
- `WritingSelection = { anchor: WritingPoint; focus: WritingPoint }`.
- `SceneSnapshot = SceneRef & { html: string; hash: string; revision: number }`.
- `SceneChange = { ref: SceneRef; expectedRevision: number; beforeHtml: string; afterHtml: string }`.
- Annotation changes accompany prose changes when markers are moved, pasted,
  or explicitly removed. Add `AnnotationChange` with the affected `SceneRef`
  and before/after arrays using existing scene comment/footnote record shapes;
  include `annotationChanges: AnnotationChange[]` on transactions/commits.
  Empty arrays mean unchanged annotations, not deletion of all records.
- `WritingTransaction = { id: string; origin: string; kind: 'input' | 'format' | 'replace' | 'structure'; changes: SceneChange[]; beforeSelection: WritingSelection | null; afterSelection: WritingSelection | null }`.
- `WritingProjection = { scope: WritingScope; anchor: SceneRef | null; selectedSceneIds: string[] | null; filter: WritingFilter }`.
  `WritingFilter` aliases `ProjectFilter` from `filterStore`; `null` means
  unrestricted selection, while `[]` means an explicitly empty selected run.
- `WritingRegistry`: `read(ref): Promise<SceneSnapshot>`,
  `capture(): readonly SceneSnapshot[]`, `apply(tx): void`,
  `subscribe(sceneId, listener): () => void`, `close(): Promise<void>`.
  Scene document ownership is keyed by complete workspace/book/draft/scene
  identity; pane projections subscribe rather than own duplicate write caches.
- `WritingHistory`: `record(tx, inverse): void`,
  `undo(): Promise<HistoryResult>`, `redo(): Promise<HistoryResult>`.
  `HistoryResult = { status: 'applied' | 'blocked'; reason?: string }`.
  History is shared by projections for the same writer/book session. An explicit
  project-wide replace entry belongs to its initiating writer/window and retains
  references across books; never reconstruct it from currently visible DOM.
- `HistoryInverse` is a discriminated local inverse (prose/annotation changes),
  shared-history token, or structural operation ID. It is validated against the
  expected scene/structure revision before execution, never a blind restore.
- `WritingCommitRequest = { transactionId: string; expectedEpoch: number; changes: SceneChange[] }`;
  commit results include per-scene hashes and a recoverable operation ID.
  Distinguish conflicts and retained-retry failure from successful commits.
- `WritingCommitResult` is a discriminated result: `committed` carries
  `operationId` and hashes keyed by complete SceneRef; `conflict` carries
  affected SceneRefs/current hashes; `retryable` carries retained `operationId`
  and a localized error code. Do not interpret failure as an acknowledgement.
- `StructureRequest = { transactionId: string; expectedEpoch: number; bookId: string; draftId: string; expectedHashes: Record<string,string>; command: StructureCommand }`.
  Task 7 defines the discriminated command payloads; no arbitrary paths supplied
  by the renderer. Server validates identity, permissions, and current epoch.

### Task 1: Prove the shared surface and produce the parity inventory

**Files:** Create `app/e2e/writing-feasibility.spec.ts`,
`app/e2e/fixtures/writingBook.ts`, and
`docs/research/unified-writing-feasibility.md`. Experiment with the current
`app/src/renderer/public/editor/editor.html`, `editor-state.js`,
`editor-content.js`, and `formatting.js` in an isolated throwaway checkout.

**Interfaces:** Produce `seedWritingBook(h, { sceneCount, wordCount, rich }): Promise<FixtureBook>`
with deterministic scene IDs; `measureWriting(page): Promise<WritingMetrics>`
reports runtime/DOM/heap counts and latency samples, never prose. Record the
chosen production transaction/selection adapter after the experiment.

- [ ] Write failing browser assertions for two-scene selection/format/delete,
  scoped serialization, undo after scope changes, IME, annotations, and local
  undo after a remote change. Representative acceptance assertions:

  ```ts
  expect(metrics.editorRuntimeCount).toBe(paneCount)
  expect(metrics.inputP95Ms).toBeLessThan(50)
  expect(afterRemoteUndo.remoteInsertionPresent).toBe(true)
  expect(serializedSceneIds).toEqual(originalSceneIds)
  ```

- [ ] Run the small fixture on an isolated desktop; confirm failures expose the
  current separate-surface/undo limitations rather than harness errors.
- [ ] Build only the experiment needed to compare common editable prose with
  protected scene boundaries against existing multi-iframe behavior. Prove the
  primitive that preserves per-scene serialization, selection, and local/shared
  undo; do not replace the editor engine.
- [ ] Run 100/500/1,000 scenes up to 1 million words and five traversal rounds.
  Include two panes, long scenes, page/typewriter mode, images, comments, and
  remote editing. Record environment, raw metrics, and each pass/fail.
- [ ] Inventory every EditorWindow command/feature from `editorBridge.ts` and
  the spec. For each, identify selection scope, affected scene, and an existing
  or new assertion. A “not implemented” parity row blocks production rollout.
- [ ] If any required gate fails, record the exact case and return for an
  architectural decision. On success, update interfaces if required and commit
  the report/harness; do not merge throwaway rendering code as production.

**Verification:** isolated runner, from `app`:
`npx playwright test e2e/writing-feasibility.spec.ts --workers=1`.
Local `--list` is safe; do not locally opt into desktop execution.

### Task 2: Establish document ownership, projections, and passive reads

**Files:** Create the types/registry/projection modules in the table;
create `Novalist.Core/Models/WritingDocument.cs` for mirrored wire contracts
and `Novalist.Core/Services/SceneDocumentReader.cs` for explicit-context reads;
modify `app/src/renderer/src/stores/projectTypes.ts`,
`projectEditorActions.ts`, `pendingWrites.ts`,
`Novalist.Backend/Rpc/ScenesRpc.cs`.
Tests: new `app/scripts/writing-documents.test.mjs`,
`writing-scope.test.mjs`; extend `tests/Novalist.Backend.Tests/ScenesRpcTests.cs`
and `InlineActionCaretTests.cs`.

**Interfaces:** Produce the shared contracts and
`resolveWritingProjection(chapters, projection): SceneRef[]`.
Add `scenes/readPassive(bookId, draftId, chapterGuid, sceneId)` returning the existing
`SceneContentDto` without SceneOpened. Add explicit
`scenes/activate(chapterGuid, sceneId)`; preserve `scenes/read` behavior.
`SceneDocumentReader.ReadAsync(SceneRef reference, CancellationToken ct)` resolves
the supplied book/draft inside the active project without changing active book
or emitting activation. Project searches use each book's active draft.

- [ ] Add failing identity/projection tests:
  ```js
  assert.equal(passiveFetchesAfterTwoSubscribersReadTheSameRef, 1)
  assert.deepEqual(resolveWritingProjection(chapters, emptySelection), [])
  assert.equal(sceneOpenedEventsAfterPrefetch, 0)
  assert.equal(sceneOpenedEventsAfterCaretActivation, 1)
  ```
  Also test independent panes, stale read after draft switch, equal scene IDs
  in different contexts, filtered order, and one pending-write owner.
- [ ] Run those Node/backend suites and verify the new behavior is missing.
- [ ] Implement passive fetch, explicit activation, retained scene documents,
  typed projections, reference counting, and workspace-epoch rejection.
  Do not replace selected/caret scene with the last prefetched scene.
- [ ] Verify close failure retains unsaved documents and cancels context switch;
  release clean resources without erasing session history. Commit after focused
  tests and typecheck pass.

**Checks:** from `app`,
`node --experimental-strip-types --test scripts/writing-documents.test.mjs scripts/writing-scope.test.mjs`;
root `dotnet test tests/Novalist.Backend.Tests/Novalist.Backend.Tests.csproj --filter "FullyQualifiedName~ScenesRpcTests|FullyQualifiedName~InlineActionCaretTests"`.

### Task 3: Make the existing editor scene-aware

**Files:** Create `public/editor/writing-document.js`,
`writing-selection.js`, `writing-transactions.js`;
modify existing `editor.html`, `editor-state.js`, `editor-runtime.js`,
`editor-content.js`, `content-input.js`, `typing-events.js`,
`clipboard-focus.js`, `formatting.js`, `annotations.js`,
`comment-bridge.js`, `footnote-bridge.js`;
extend `views/editor/editorBridge.ts`, `useEditorMessages.ts`,
`useEditorSynchronization.ts`.
Tests: new `app/scripts/writing-document-dom.test.mjs`,
`app/e2e/writing-cross-scene-editing.spec.ts`; extend
`editor-composition.spec.ts` and `editor-content-capture.spec.ts`.

**Interfaces:** Add EditorWindow methods
`setWritingProjection(scenes: SceneSnapshot[], selection: WritingSelection | null): void`,
`captureWritingChanges(): WritingTransaction[]`,
`getWritingSelection(): WritingSelection | null`,
`restoreWritingSelection(selection): void`,
`revealWritingPoint(point): void`.
Legacy single-scene `setContent/getContent` remain adapters.

- [ ] Add failing DOM/browser cases:
  ```js
  assert.deepEqual(captured.changes.map(x => x.ref.sceneId), ['s1', 's2'])
  assert.equal(serializeScene('s1').includes('data-editor-chrome'), false)
  assert.deepEqual(sceneIdsAfterCrossSceneDelete, ['s1', 's2', 's3'])
  assert.equal(imeTextAfterScopeSwitch, expectedComposedText)
  ```
  Cover reverse selections, inline markup, lists, emoji/Unicode offsets,
  duplicate annotation IDs, empty scenes, pasted HTML, and hidden scenes.
- [ ] Verify the baseline fails the focused cases on the isolated runner.
- [ ] Implement the proven common-root adapter with stable scene wrappers,
  protected structural chrome, canonical text-offset conversion, sanitized
  scene serialization, and before/after transaction reporting. Never reset
  all HTML on every input or rebuild unaffected roots on scope changes.
- [ ] Route caret-specific commands to the active scene and selection-specific
  commands across touched scenes. Qualify annotations by scene identity;
  clipboard text excludes UI labels while preserving prose paragraph breaks.
- [ ] Prove unchanged single-scene/mobile behavior plus the new cross-scene
  cases; commit only with local DOM checks and isolated browser evidence.

**Checks:** `node --experimental-strip-types --test scripts/writing-document-dom.test.mjs`
from `app`; isolated `npx playwright test e2e/writing-cross-scene-editing.spec.ts e2e/editor-composition.spec.ts e2e/editor-content-capture.spec.ts --workers=1`.

### Task 4: Add persistent history and recoverable local compound writes

**Files:** Create `stores/writingHistory.ts`, `writingPersistence.ts`,
`Novalist.Core/Services/WritingOperationJournal.cs`,
`Novalist.Backend/WritingMutationCoordinator.cs`, `Rpc/WritingRpc.cs`;
modify `sceneWriteQueue.ts`, `projectPersistence.ts`,
`Novalist.Backend/BackendHost.cs`, `WorkspaceCoordinator.cs`.
Tests: new `app/scripts/writing-transactions.test.mjs`,
`tests/Novalist.Core.Tests/Services/WritingOperationJournalTests.cs`,
`tests/Novalist.Backend.Tests/WritingRpcTests.cs`; extend
`WorkspaceCoordinationSafetyTests.cs` and existing pending-capture/write suites.

**Interfaces:** Produce `WritingHistory`,
`commitWritingTransaction(tx): Promise<WritingCommitResult>`;
RPC `writing/commit(WritingCommitRequest)`.
Backend coordinator exposes
`CommitAsync(WritingCommitRequest request, CancellationToken ct)`.
Journal has `PrepareAsync`, `CommitAsync`, `RollbackAsync`, and
`RecoverAsync` over a validated affected-file manifest; caller-supplied
paths are forbidden. Journal contents are protected project data, not logs.

- [ ] Add failing cases for one-step two-scene undo, history after remount,
  two panes editing one scene, dirty change during slow save, stale epoch/hash,
  a refusing window, failure on the second file, and restart recovery.
  ```js
  assert.deepEqual(afterUndo.proseByScene, beforeTransaction.proseByScene)
  assert.equal(afterFailedCommit.pendingTransactionId, transaction.id)
  assert.equal(afterOldAcknowledgement.newerTextStillDirty, true)
  ```
- [ ] Run focused Node/Core/backend tests and verify failures.
- [ ] Implement writer-session history and grouped commit ownership, capturing
  iframe edits before save/teardown. Validate all hashes before mutation;
  retain affected metadata/files and inverse operations. Recover/roll back
  partial local mutations under the workspace gate before publishing state.
- [ ] Keep ordinary one-scene APIs working. Do not replace the old entire save
  system at once or clear dirty flags for text newer than the acknowledged
  transaction. Project-wide replacement history retains cross-book references.
- [ ] Verify injected interruption at every journal phase, replay idempotency,
  conflict retry, and shutdown veto, then commit.

**Checks:** from `app`,
`node --experimental-strip-types --test scripts/writing-transactions.test.mjs scripts/pending-writes.test.mjs scripts/editor-pending-capture.test.mjs`;
root Core/backend `dotnet test` filtered to the new journal/RPC and
WorkspaceCoordinationSafety suites.

### Task 5: Preserve collaborative undo and bound expensive services

**Files:** Create `app/src/renderer/src/collaboration/SharedWritingHistory.ts`,
`views/editor/writingServiceScheduler.ts`;
modify `collaboration/CollaborativeScene.ts`, `SharedEditorSession.ts`,
`sharedDocuments.ts`, `sharedEditors.ts`,
`views/editor/useEditorAnnotations.ts`, `useEditorEntityRequests.ts`;
adapt `public/editor/grammar-events.js`, `grammar-highlights.js`,
`entity-matching.js`, `mentions.js`, `read-aloud.js`, `dictation.js`,
`suggestions.js`, `readability.js`, and `inline-actions.js` to scene identity.
Tests: new `app/scripts/shared-writing-history.test.mjs`,
`writing-services.test.mjs`; extend `shared-editor-detach.test.mjs`,
`app/e2e/collaboration-manuscript.spec.ts`, `shared-editor-persistence.spec.ts`.

**Interfaces:** `SharedWritingHistory.begin(id, origin)`,
`capture(sceneId, transaction)`, `commit(id)`, `undo(id)`, `redo(id)`.
Undo/redo return `Promise<HistoryResult>` from the shared contracts.
`WritingServiceScheduler.update({ visibleSceneIds, activeSceneId, composingSceneIds, selectedSceneIds }): void`
and `dispose(): Promise<void>`. Service requests/results carry scene identity
and revision. Document/history lifetime is separate from mounted bindings.

- [ ] Add failing assertions for a two-scene action followed by remote insertion:
  ```js
  assert.equal((await history.undo(id)).status, 'applied')
  assert.equal(remoteTextStillPresent, true)
  assert.equal(historySurvivesBindingDetach, true)
  assert.equal(activeServiceCountAfterFiveTraversals, initialActiveServiceCount)
  ```
  Include IME teardown veto, hidden dirty documents, two local panes, remote
  deletion with recovered-copy behavior, and stale proofing results.
- [ ] Confirm focused Node/shared-browser cases fail before ownership changes.
- [ ] Keep local-origin Yjs history for edited scenes; release clean unused
  view bindings and services without destroying needed history. Group managers
  by logical transaction ID so one undo affects only that writer's contribution.
  Pin composing/selected content and retain failed sends.
- [ ] Schedule heavy proofing/entity/media work for visible/active/pinned scenes;
  cancel stale work on revision/context change. Read-aloud/dictation and extension
  actions target the active scene or an explicitly selected range.
- [ ] Prove feature parity from Task 1's inventory, no runtime accumulation,
  and safe remote undo before committing. Shared prose never passes through
  the ordinary local-file commit path.

**Checks:** focused Node suites above; isolated
`npx playwright test e2e/collaboration-manuscript.spec.ts e2e/shared-editor-persistence.spec.ts --workers=1`.
Extend existing backend `SharedScenePersistenceTests`/`SharedDocumentBridgeTests`
when wire behavior changes.

### Task 6: Model ordered acts without breaking project files

**Files:** Create `Novalist.Core/Services/ActStructureService.cs`;
create `Novalist.Core/Models/ActStructure.cs` for the group/validation/result types;
extend `Novalist.Backend/Workspace.State.cs`, `Workspace.cs`,
`app/src/renderer/src/stores/projectTypes.ts`;
preserve storage in `Novalist.Core/Models/ActData.cs`, `ChapterData.cs`,
`BookDraftData.cs`, and `ProjectService.Migrations.cs`.
Tests: new `tests/Novalist.Core.Tests/Services/ActStructureServiceTests.cs`,
`tests/Novalist.Backend.Tests/ActStructureStateTests.cs`.

**Interfaces:** `ActStructureService.Build(BookData book): ActStructure`,
`ValidateRename(BookData book, string oldName, string newName): ActValidation`,
`CreateAsync(string name, string? beforeActName, CancellationToken ct)`,
`RenameAsync(string oldName, string newName, CancellationToken ct)`,
`RemoveAsync(string name, CancellationToken ct)`,
`MoveAsync(string name, string? beforeActName, CancellationToken ct)`.
The mutation methods return `Task<ActMutationResult>` containing changed chapter
GUIDs and reversible metadata changes. `ActStructure` carries ordered groups and
validation issues; `ActValidation` carries `IsValid`, a stable error code, and
conflicting reference scopes. Groups identify name/null for unassigned, ordered
chapter GUIDs, and optional act metadata. No renderer invents these group rules.
Expose ordered act metadata and validation issues in project state; projection
contains named groups, empty acts, and position-preserving unassigned runs.

- [ ] Add failing cases for empty acts, contiguous groups, unassigned chapters,
  case-insensitive uniqueness, all chapters moving with their act, legacy
  interleaving, and old mobile serialization round-trip. Essential assertions:
  ```csharp
  Assert.Equal(beforeOrder, orderAfterLoadingLegacyData);
  Assert.Equal(expectedWholeActOrder, orderAfterMove);
  Assert.False(renameIntoConflictingSharedMetadata.IsValid);
  ```
- [ ] Verify failures in the new Core/backend suites.
- [ ] Implement canonical chapter-order projection and mutations over the
  existing name-based lists. Preserve the spec's empty-act placement rule;
  do not add invisible ordering metadata that older clients discard.
- [ ] Preflight rename references in `StoryPremise.Acts`,
  `CharacterOverride.Act`, `EntityStateOverride.Act`, and narration scope IDs.
  If the destination name already carries conflicting shared metadata, reject
  before mutation. Copy retained shared references when the old name remains
  in another draft; never overwrite unrelated context.
- [ ] Validate legacy assignments, produce a regrouping preview with before/after
  chapter IDs, and retain existing order until explicitly applied. Rejection
  never disables ordinary prose writing.
- [ ] Verify date/word-target semantics, export tokens, imported acts, draft
  switching, and nondestructive removal; commit.

**Checks:** root Core/backend `dotnet test` filtered to
`ActStructureServiceTests|ActStructureStateTests`; include existing word-target,
timeline, draft, and export tests whenever their projection changes.

### Task 7: Commit structural actions as one recoverable operation

**Files:** Create `Novalist.Core/Models/WritingStructure.cs`,
`Services/ManuscriptStructureService.cs`,
`Novalist.Backend/Workspace.SharedWriting.cs`;
extend `Rpc/WritingRpc.cs`, `WritingMutationCoordinator.cs`,
`WorkspaceCoordinator.cs`, `Workspace.CollaborationWriteGuard.cs`,
`app/src/renderer/src/stores/projectSceneActions.ts`,
`views/editor/editorActionMessages.ts`,
`public/editor/context-menu-actions.js`.
Reuse `SceneSplitService.cs`, `SceneAnnotationTransfer.cs`,
`ProjectService.Chapters.cs`, `ProjectService.Scenes.cs`.
Tests: new `ManuscriptStructureServiceTests.cs` in Core Services tests,
`WritingStructureRpcTests.cs` in backend tests,
`app/scripts/writing-structure.test.mjs`,
`app/e2e/writing-structure.spec.ts`; extend split/coordinator/shared-guard suites.

**Interfaces:** `writing/structure(StructureRequest): StructureResult`,
`writing/undoStructure(operationId, expectedEpoch)`,
`writing/redoStructure(operationId, expectedEpoch)`.
`StructureResult` returns operation ID, updated state/hashes, and focus scene.
`ManuscriptStructureService.ExecuteAsync(request, ct)` composes existing
services under Task 4's coordinator/journal, not multiple renderer RPCs.

Define `StructureCommand` as these typed variants:

| kind | payload beyond common context |
| --- | --- |
| splitScene | scene ref, beforeHtml, afterHtml |
| splitChapter | scene ref, title, beforeHtml, afterHtml |
| insertChapter | title, beforeChapterGuid or null for end, actName or null |
| moveScenes | scene IDs, targetChapterGuid, beforeSceneId or null |
| moveChapters | chapter GUIDs, beforeChapterGuid or null, targetActName or null |
| createAct / renameAct / removeAct / moveAct | named arguments from Task 6 |
| regroupActs | validated preview token and expected structure revision |

- [ ] Write failing behavioral assertions:
  ```js
  assert.deepEqual(splitChapterSceneTitles, ['new half', 'following scene'])
  assert.equal(newBoundaryChapter.scenes.length, 1)
  assert.deepEqual(afterUndo.chapterIds, before.chapterIds)
  assert.equal(remainingRemoteContentAfterBlockedUndo, remoteContent)
  ```
  Cover caret at either edge, empty book, cancelled naming, duplicate annotation
  IDs, partial file failure, stale grouping preview, sorted multi-selection,
  cross-act reassignment, and remote edits during the operation.
- [ ] Run focused tests, verify failures, then implement preflight/compound
  operations. Resolve destinations after removing movers, using the full
  manuscript order even when the UI is filtered.
- [ ] Integrate comment/footnote transfer and recounting. Return the correct
  caret target; record one inverse including all metadata/file changes.
- [ ] For shared projects, coordinate shared prose changes/binding transfer with
  the existing project-file lease/batch and recovery mechanisms. Keep structural
  connectivity guards. Reject unsafe inverses after remote changes; preserve
  recovered copies and all pending collaborator work.
- [ ] Verify write failures roll back/recover before state publication, rather
  than inheriting the current coordinator's partial-mutation behavior. Commit
  after focused tests and isolated structural/collaboration checks.

**Checks:** focused Core/backend `dotnet test` for the new suites plus
`SceneSplitServiceTests|SceneSplitRpcTests|WorkspaceCoordinationSafetyTests|SharedProjectWriteGuardTests`;
Node `scripts/writing-structure.test.mjs`; isolated
`e2e/writing-structure.spec.ts` and `e2e/workspace-windows-regression.spec.ts`.

### Task 8: Search live and unloaded prose, with transactional replacement

**Files:** Create `app/src/renderer/src/views/editor/writingSearch.ts`,
`Novalist.Core/Models/WritingSearch.cs`,
`Novalist.Backend/Rpc/WritingSearchRpc.cs`;
extend `FindReplaceDialog.tsx`, `FindReplaceService.cs`,
`HtmlSearchText.cs`, `BackendHost.cs`.
Tests: new `app/scripts/writing-search.test.mjs`,
`app/e2e/writing-search.spec.ts`; extend
`FindReplaceServiceTests.cs`, `HtmlSearchTextTests.cs`, `SearchRpcTests.cs`.

**Interfaces:** `WritingSearchRequest` carries existing FindOptions, explicit
target scene refs/scope, dirty snapshot overrides, and workspace epoch.
`writingSearch/find(request): WritingMatch[]`; matches contain SceneRef,
field, index, length, snapshot hash/revision.
`writingSearch/prepareReplace(request, matches, replacement): SceneChange[]`
computes validated replacements without writing. Host applies changes as one
Task 4/5 transaction. Retain old search RPC signatures for existing clients.

- [ ] Add failing assertions:
  ```js
  assert.deepEqual(foundSceneIds, ['dirty-visible', 'clean-offscreen'])
  assert.equal(highlightedText, expectedMatch)
  assert.equal(hiddenFilteredSceneChanged, false)
  assert.deepEqual(afterReplaceAllUndo, beforeReplaceAll)
  ```
  Include regex timeout/invalid pattern, inline markup, non-BMP Unicode,
  a phrase straddling a scene break (no match), stale result, remote change,
  and project-wide replacement with another book open in a second window.
- [ ] Confirm failures in Node/Core/backend and isolated navigation tests.
- [ ] Build an immutable search snapshot by capturing pending content in all
  participating windows; overlay dirty versions on passive backend reads.
  Do not persist merely to make text searchable and do not change the active
  backend book as an observable side effect of project search.
- [ ] Add projection-default scope, wider choices, exact range navigation,
  next/previous, Replace current, and Replace All. Use the same canonical
  text-offset mapping as Task 3; reload/revalidate changed matches.
- [ ] Route local/shared prose replacement through their transaction owners,
  with one undo group even for multiple books. Keep optional non-prose search
  and existing notes replacement/snapshot semantics separate and accurate.
- [ ] Verify failure/cancellation never clears pending content or leaves an
  unexplained partial replacement; commit.

**Checks:** `node --experimental-strip-types --test scripts/writing-search.test.mjs`
from `app`; Core/backend filtered search suites; isolated
`npx playwright test e2e/writing-search.spec.ts e2e/audit-search-navigation.spec.ts --workers=1`.

### Task 9: Add paragraph styles and structure actions to quick edit

**Files:** Modify `app/src/renderer/public/editor/editor.html`,
`selection-toolbar-events.js`, `proofing-toolbar.js`,
`context-menu-rendering.js`, `context-menu-actions.js`,
`app/src/renderer/src/views/editor/EditorToolbar.tsx`,
`editorConfiguration.ts`, `shell/commandTypes.ts`, `editorCommands.ts`,
`tools/placement-doctor.py`, `tools/test_placement_doctor.py`,
and `locales/en.json`, `de.json`, `zh-CN.json`.
Tests: new `app/scripts/writing-quick-edit.test.mjs`;
extend `app/e2e/m60-responsive-writing.spec.ts`.

**Interfaces:** Add `transientHomes?: readonly CommandContainer[]` to
`CommandDef`. Paragraph styles retain `viewBar` as persistent home and
declare selectionToolbar/contextMenu transient access. Add
`editor.quickEdit` and structural command IDs
`writing.sceneBreak`, `writing.chapterHeading`, `writing.insertChapter`.
The first opens the picker for the saved range/caret; the latter dispatch Task 7.

- [ ] Add failing placement and interaction tests:
  ```js
  assert.equal(selectionAfterChoosingStyle, selectionBeforeOpeningPicker)
  assert.equal(bodyStyleAtEmptyCaret, '')
  assert.equal(ordinaryHeadingCreatedScene, false)
  ```
  Python tooling must accept only declared transient access and still reject
  undeclared duplicates or two persistent homes.
- [ ] Run Node/tooling tests to confirm failures.
- [ ] Add style/structure groups to the bubble with preserved selection,
  keyboard focus, mixed-state labeling, Escape dismissal, and viewport clamping.
  Keep native picker interaction working; do not prevent all pointer events.
- [ ] Expose the same picker through context menu/palette at a collapsed caret
  and empty paragraph. Retain fixed-toolbar access and all existing bubble tools.
- [ ] Verify locale/placement checks and isolated responsive keyboard/pointer
  cases, then commit.

**Checks:** root `python -m unittest tools/test_placement_doctor.py`,
`python tools/placement-doctor.py`, `python tools/locale-doctor.py`;
Node `scripts/writing-quick-edit.test.mjs`; isolated responsive-writing E2E.

### Task 10: Build the scoped writing UI and compact synopsis margin

**Files:** Create `app/src/renderer/src/views/editor/UnifiedWritingEditor.tsx`,
`WritingSceneMargin.tsx`, `unified-writing.css`;
modify `EditorFrame.tsx`, `EditorToolbar.tsx`, `writingTypography.ts`,
`stores/projectTypes.ts`, `shell/MainArea.tsx`,
`shell/SceneSynopsisField.tsx`, `styles/tokens.css`,
`public/editor/typography.js`, `page-layout.js`, `typewriter-scroll.js`,
and the three locale files.
Tests: new `app/scripts/writing-presentation.test.mjs`,
`app/e2e/writing-scope.spec.ts`; extend `scene-synopsis-persistence.test.mjs`,
`editor-responsive-page.spec.ts`, `writing-zoom-layout.spec.ts`.

**Interfaces:** `UnifiedWritingEditor({ paneId }: { paneId: string })`;
`WritingSceneMargin({ scene, expanded, onExpandedChange })` uses the shared
synopsis document. Add per-pane `writingScope: WritingScope` without storing
prose in preferences. Add writer-local presentation storage keyed by project,
book, draft, and scene; master visibility is project-local.

- [ ] Add failing assertions:
  ```js
  assert.equal(newPane.writingScope, 'manuscript')
  assert.equal(otherPane.writingScope, 'scene')
  assert.equal(canvas.querySelectorAll('[data-scene-title]').length, 0)
  assert.equal(reopenedSynopsis.value, lastTypedSynopsis)
  ```
  Cover caret retention, all-empty chapters, narrow split panes, focus mode,
  synopsis editing immediately before collapse, failed saves, and remote refresh.
- [ ] Confirm failures, then mount one runtime per pane using the existing
  editor configuration/feature bridge, with projections from Task 2.
- [ ] Add scope switcher, scene separators without titles, chapter headings,
  active-scene context, word counts, collapsible synopsis, and chapter/scene
  boundary insertion controls. Empty books have actionable creation controls.
- [ ] Apply the spec's token-based compact dimensions and responsive fallback.
  Preserve user reading width, zoom-to-fit, page view, typewriter scrolling,
  compose dimming, selection, and focus-mode behavior across scopes.
- [ ] Verify both local and shared synopses use the established document
  lifecycle; commit after focused Node and isolated layout/scope checks.

**Checks:** focused Node suites and `npm --prefix app run typecheck`;
isolated `e2e/writing-scope.spec.ts`, `e2e/editor-responsive-page.spec.ts`,
`e2e/writing-zoom-layout.spec.ts`, `e2e/collaboration-scene-notes.spec.ts`.

### Task 11: Add the Structure board and preserve existing planning tools

**Files:** Create the Structure modules in the responsibility table,
`app/src/renderer/src/views/manuscript/PlanningView.tsx`,
`stores/planningStore.ts`, `Novalist.Backend/Rpc/PlanningRpc.cs`;
modify `BackendHost.cs`, existing `Corkboard.tsx`, `Outliner.tsx`,
`Board.tsx`, `stores/manuscriptTypes.ts`,
`shell/BinderChapters.tsx`, `binderChapterMenu.ts`,
`SceneBulkBar.tsx`, `shell/modes.ts`, `MainArea.tsx`, locale files.
Tests: new `app/scripts/structure-planning.test.mjs`,
`tests/Novalist.Backend.Tests/PlanningRpcTests.cs`,
`app/e2e/structure-planning.spec.ts`; extend existing Board/Manuscript-field E2E.

**Interfaces:** `planning/get(): PlanningStateDto` returns ordered act metadata
and chapters (including empty ones), chapter descriptions, and all existing
planning scene fields without HTML/hash/shared-prose payloads.
`buildStructureRows(state, filter): StructureRow[]` keeps stable IDs and full
order destinations. `PlanningView` offers Structure, Corkboard, Outliner, Board.
Add discoverable `MainView = 'structure'` under Plan; preserve other Plan tools.

- [ ] Add failing assertions:
  ```js
  assert.equal(proseReadCallsDuringPlanningLoad, 0)
  assert.deepEqual(emptyChapterIdsShown, emptyChapterIdsInProject)
  assert.deepEqual(chapterOrderAfterActDrag, expectedWholeActOrder)
  assert.deepEqual(manuscriptOrderAfterFreeformCardDrag, originalOrder)
  ```
  Cover keyboard moves, acts/unassigned runs, filtered destination resolution,
  inactive scenes, collapsed groups, cancellation, and live synopsis edits.
- [ ] Confirm new tests fail.
- [ ] Implement metadata-only planning retrieval using the manifest/project
  metadata. Preserve POV, goal, outcome, custom properties, labels/stages and
  shared synopsis references needed by existing tools; do not use prose-loading
  `manuscript/get` merely to draw cards.
- [ ] Build Structure's chapter summaries and scene cards, ordered act groups,
  precise before/after/inside drop indicators, keyboard move menus, and creation.
  Dispatch Task 7 transactions rather than direct move RPCs. Edit summaries
  only in active fields; do not mount hundreds of Markdown editors for previews.
- [ ] Keep Corkboard freeform coordinates, Board grouping semantics, Outliner
  fields, filter chips, Smart Lists, multi-selection, and “Read as one.”
  Legacy ordering problems use an explicit preview/repair workflow, never an
  on-load reorder.
- [ ] Verify planning updates reflect immediately in Write/outline/export order,
  and save failures retain editing values; commit.

**Checks:** new Node/backend suites; isolated
`e2e/structure-planning.spec.ts`, `e2e/m12-board.spec.ts`,
`e2e/m12-manuscript-fields.spec.ts`, `e2e/m43-structure.spec.ts`.

### Task 12: Migrate navigation/layouts and retire the duplicate desktop writer

**Files:** Create `app/src/renderer/src/stores/writingLayoutMigration.ts`;
modify `shellTypes.ts`, `shellPanes.ts`, `layoutStore.ts`,
`shell/commands.ts`, `menuLayout.ts`, `modes.ts`, `ModePanel.tsx`,
`MainArea.tsx`, `DetachedPane.tsx`, `SceneBulkBar.tsx`,
`stores/manuscriptStore.ts`, `views/manuscript/ManuscriptView.tsx`,
`ManuscriptFrame.tsx`, and desktop references to its autosave/pending-write path.
Inspect `MobileShell.tsx`/`TabletShell.tsx` before removing any legacy adapter.
Tests: new `app/scripts/writing-route-migration.test.mjs`;
extend `writing-scope.test.mjs`, `manuscript-filter-reload.test.mjs`,
`app/e2e/split-pane-navigation.spec.ts`, `m32-pane-window.spec.ts`,
`m15-shared-filters.spec.ts`, `mobile-tablet-parity.spec.ts`.

**Interfaces:** `normalizeWritingLayout(input: unknown): PersistedPaneLayout`
validates/migrates old recursive layouts; reuse its leaf normalizer for named
workspace layouts. Persist an optional writing scope on each saved writing
leaf; named workspaces capture the same pane preferences. Migration is idempotent.
Legacy `nav.manuscript`/Ctrl+D5 maps to Write + Manuscript scope on desktop.

- [ ] Add failing assertions:
  ```js
  assert.equal(migratedLegacyLeaf.view, 'write')
  assert.equal(migratedLegacyLeaf.writingScope, 'manuscript')
  assert.deepEqual(migrate(migrate(oldLayout)), migrate(oldLayout))
  assert.deepEqual(restoredPaneScopes, ['scene', 'manuscript'])
  assert.deepEqual(explicitEmptySelection.sceneIds, [])
  ```
  Include missing/unknown fields, detached panes, stale selected IDs, and another
  project. Scope is part of persisted-pane equality; changing only scope must
  not be mistaken for an unchanged layout.
- [ ] Confirm failures and implement both storage migrations without discarding
  unrelated layout choices. Scene navigation preserves the pane's current scope.
- [ ] Route filtered/selected writing to the new projection, preserve exact
  selected ID semantics, and add the visible scope/filter label and clear action.
  Fetch/selection/filter changes never discard pending writes or reset history.
- [ ] Redirect desktop prose entry points and remove the duplicate desktop save
  owner. Keep legacy assets/adapters wherever mobile still uses them; deletion
  is allowed only after all callers are migrated and mobile parity is proven.
  Update unsaved guards and recovery consumers explicitly.
- [ ] Verify modes, commands, menus, links, named layouts, tabs, tear-off windows,
  project/draft changes, and mobile scene writing; commit.

**Checks:** new migration/scope Node tests plus existing pending/external refresh
suites; desktop and mobile typecheck/build; isolated split-pane/filter/mobile
regression tests. Do not run mobile UI actions on the user's desktop.

### Task 13: Complete parity, performance acceptance, and release documentation

**Files:** Create `app/e2e/writing-performance.spec.ts`,
`writing-recovery.spec.ts`; extend `writingBook.ts` from Task 1,
`.github/workflows/ci.yml` as needed for isolated evidence collection;
update `docs/research/unified-writing-feasibility.md`,
`docs/manual/05-editor.md`, `10-manuscript.md`,
`37-planning-board.md`, `README.md`, and `CHANGELOG.md`.
Review glossary/spec/ADR terminology against implemented behavior.

**Interfaces:** Reuse `WritingMetrics`/fixtures from Task 1. CI artifact contains
hardware/runtime identity, fixture dimensions, raw timing/count/memory series,
and pass/fail per gate, never story text or private project paths.

- [ ] Add failing integrated assertions for 1,000 scenes/1 million words,
  five traversals, independent panes, selected/filtered search, typing during
  background work, and crash/reopen after a partial compound write.
  ```ts
  expect(metrics.inputP95Ms).toBeLessThan(50)
  expect(metrics.editorRuntimeCount).toBe(metrics.writingPaneCount)
  expect(metrics.maxLateTraversalHeap).toBeLessThanOrEqual(
    metrics.round2Heap * 1.10 + 8 * 1024 * 1024)
  expect(recovery.missingOrOverwrittenEdits).toBe(0)
  ```
- [ ] Run on isolated reference hardware. Compare every Task 1 parity row with
  an implemented assertion; no feature marked missing may pass the gate.
- [ ] Fix observed failures through their owning tasks, without weakening
  coverage, placement rules, or performance targets. Re-run affected checks.
- [ ] Update the user manual for scopes, hidden scene titles, acts, synopsis
  margin, quick-edit styles, structure creation, filtered writing, and undo/search.
  Check release tags and Unreleased first; update one final Added entry and
  leave published sections unchanged. Preserve separate Fixed entries only for
  bugs in previously released behavior.
- [ ] Run the final checks below, inspect diffs, retain evidence, and commit the
  documentation/verification changes. Obtain a whole-branch review before
  integration; this plan does not itself authorize merging or releasing.

## Final verification commands

Safe local checks from repository root (run only after implementation):

```powershell
git diff --check
npm --prefix app run test:transport
npm --prefix app run typecheck
npm --prefix app run build
npm --prefix app run build:mobile
python tools/check-source.py
python -m unittest discover -s tools -p "test_*.py"
aislop scan --changes --json
dotnet test tests/Novalist.Core.Tests/Novalist.Core.Tests.csproj --settings tests/coverlet.runsettings --results-directory artifacts/coverage/core
dotnet test tests/Novalist.Backend.Tests/Novalist.Backend.Tests.csproj --settings tests/coverlet.runsettings --results-directory artifacts/coverage/backend
dotnet test tests/Novalist.Sdk.Tests/Novalist.Sdk.Tests.csproj --settings tests/coverlet.runsettings --results-directory artifacts/coverage/sdk
dotnet test tests/Novalist.Sync.Client.Tests/Novalist.Sync.Client.Tests.csproj
./eng/Check-Coverage.ps1 -CoberturaGlob 'artifacts/coverage/core/**/coverage.cobertura.xml' -Package Novalist.Core
./eng/Check-Coverage.ps1 -CoberturaGlob 'artifacts/coverage/backend/**/coverage.cobertura.xml' -Package Novalist.Backend
./eng/Check-Coverage.ps1 -CoberturaGlob 'artifacts/coverage/sdk/**/coverage.cobertura.xml' -Package Novalist.Sdk
```

Run the existing CI E2E matrix plus all new writing/structure suites on isolated
runners. The workflows already provide the required desktop opt-in; do not
copy that environment flag onto the user's workstation. Local test discovery
with `npx playwright test --list` is safe. Retain reference-machine timing
evidence separately from noisy shared-runner timing.

## Handoff and integration boundaries

- Tasks 1–5 establish the editing foundation; do not replace the user-visible
  desktop writer until scope, structure, search, layout, and parity tasks pass.
- Tasks 6–7 establish act and structural operations; Task 11 supplies their
  discoverable planning UI. Do not ship backend-only capabilities.
- Keep existing project/scene identities and mobile behavior throughout.
  There is no silent auto-regrouping, editor replacement, or discarded feature.
- Review the spec and this plan together before implementing. Recommended
  execution is task-by-task with an independent review at each foundation/
  persistence/structure boundary because a regression can affect writing.
