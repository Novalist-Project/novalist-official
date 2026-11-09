# Unified writing workspace

Product requirements confirmed through the design interview on 2026-11-09.
Implementation authorized on 2026-11-09. No production code has changed;
module boundaries remain subject to the feasibility gate.

## Intent and references

Give scene, chapter, and manuscript writing the same capabilities in one editor.
Use Plan for summaries and arrangement, eliminating the duplicate manuscript
prose editor without losing its tools.

- [Interactive mockup](../../prototypes/unified-editor.html): interaction
  reference, not production code. This specification supersedes its details.
- [PR #64](https://github.com/Novalist-Project/novalist-official/pull/64):
  inspected open/unmerged at `8cf191c95ee62caa3f6a8ce61a438ad8e7f8ebfb`,
  targeting `dev`. It already virtualizes heavyweight scene editors.
- Local inspection: main `0ef6382f71f0c44c03475ed14cb83720ca01906f` (3.7.2).
  Recheck both revisions before execution. Do not assume PR files exist locally
  or automatically merge/cherry-pick the PR.
- [Architecture decision](../../adr/0008-unified-writing-surface.md) extends
  [ADR 0006](../../adr/0006-extend-existing-editor-for-collaboration.md).

## Writing scopes and presentation

- New panes default to Manuscript; retain Scene and Chapter scopes. Each pane
  owns and saves its scope independently, including named layouts.
- Manuscript means the active book/draft. Switching scopes retains the active
  scene, caret/selection, pending changes, and undo. Scenes remain separate.
- Support selection, copying, formatting, deletion, and find/replace across
  scenes. Ordinary editing preserves structural boundaries and empty scenes.
- Preserve selected-scene “Read as one,” smart lists, and existing filters.
  Clearly label a limited run and offer **Show whole manuscript**. Explicit
  selected IDs override filters as today; zero matches means an empty result.
  Ordinary editing affects only displayed scenes.
- No scene titles above the prose or in its margin. Titles remain organizational
  metadata in navigation, tabs, inspector, and Plan.
- Keep chapter headings and structural controls distinct from scene prose and
  excluded from scene serialization/copied prose. Existing chapter subtitle,
  section-type, heading visibility, and export settings retain their meaning.

## Synopsis, spacing, and quick edit

- Put the directly editable synopsis below each scene's word count in the left
  margin. Reuse `SceneSynopsisField` and its existing local/shared document
  ownership, Markdown behavior, pending writes, and recovery.
- Start collapsed, remember expansion locally per writer/project/book/draft/scene,
  and provide master show/hide. Personal presentation is not collaborative data.
- Reduce outer padding and margin-to-prose gaps without reducing configured
  reading width or resetting zoom, page view, reading comfort, and focus settings.
- Builder sizing proposal: collapsed margin 72 px; expanded synopsis 176 px;
  gap and outer horizontal padding 12 px. Define values centrally as tokens.
  Below 320 px remaining prose width, collapse the inline margin and retain
  synopsis access in a popover/inspector. These are reviewable layout choices,
  not new user settings or a new mobile layout.
- Keep the fixed style selector and add Body, Heading, Subheading, Block quote,
  and Verse to the transient selection bubble. Preserve selections and mixed
  styles when operating the picker.
- Make that picker accessible at a lone caret/empty paragraph through context
  menu and a keyboard-accessible palette command. No permanent bubble is needed.
- Ordinary Heading/Subheading remain text formatting. Separate **Scene break**
  and **Chapter heading** actions create structure. Do not automatically turn
  ordinary `#`/`##` text or existing paragraph headings into scene records.
- Update command-placement metadata/checks to recognize explicitly declared
  transient access while retaining one persistent home. Do not disable rules.

## Structural insertion

- **Scene break:** split at a collapsed caret. Keep preceding prose and original
  identity; move trailing prose to a new scene with a normal generated metadata
  title. Allow empty halves at scene edges. Do not display the title on-canvas.
- **Chapter heading:** split there and put the trailing prose plus subsequent
  scenes of the current chapter into a newly inserted chapter. Unaffected later
  chapters retain order.
- **New chapter between chapters:** insert a fresh chapter with one empty scene.
  Also support beginning/end and an empty book. A compact naming prompt cancels
  without mutation. Inherit the preceding/current act; before the first chapter
  inherit the following chapter's act, or remain unassigned.
- Show the destination. Cursor insertion in filtered writing uses the source
  scene's actual position. Do not show a boundary insertion control across a
  gap hiding intervening chapters.
- Each insertion, move, act mutation, and regrouping is one undoable action.
  Structural caret commands require a collapsed caret; do not guess a split
  point from a multi-scene selection.
- Reuse marker-aware annotation transfer: comments/footnotes, planning/privacy
  metadata, plotlines, counts, and snapshot identity follow established split
  rules. Keep synopsis on the original half rather than duplicating it.
- Cross-scene text deletion leaves containers intact. Protect boundaries from
  ordinary Backspace/Delete/paste. Merging structure remains explicit.

## Acts and Structure board

- Acts are optional ordered containers of consecutive chapters. Each chapter
  has at most one act; unassigned chapters remain possible. Normal operations
  cannot produce interleaved act membership.
- Moving an act moves its chapters in order. Dropping a chapter into another
  act reassigns it. Multi-selection moves preserve manuscript order, not
  dictionary enumeration or selection-click order.
- Allow empty acts. Rename assignments/date/word target together. Removing an
  act leaves its chapters and prose in place, unassigned; inverse data retains
  complete act metadata.
- Scope operations to the active draft. Preserve story-premise, character-state,
  entity-override, and narration references on rename. Do not globally rewrite
  unrelated drafts/books; copy shared name-keyed values when the old name
  remains in use elsewhere.
- Preflight source and destination references on act rename. If a destination
  name already has conflicting shared metadata, reject before mutation and
  explain the conflict instead of overwriting another draft's state.
- Reuse the existing ordered `Acts` list and chapter `Act` names, unique
  case-insensitively within a draft. Chapter `Order` remains canonical reading
  order. No new act IDs or incompatible project schema is planned.
- Validate imported/older assignments before act operations. Inconsistent legacy
  data is a repair state, not supported normal ordering. Preserve reading order
  and prose, explain conflicts, and require approval of a regrouping preview.
  Never reorder a book merely by opening it.
- Empty acts are ordered relative to other acts: immediately before the next
  populated act, or at the end, without moving unassigned chapters. Arbitrary
  empty-act placement between individual unassigned chapters is outside this
  iteration because existing storage cannot represent it.
- Add **Structure** under Plan: ordered act/chapter groups, chapter summaries,
  scene synopsis cards, precise drag targets, keyboard moves, collapse controls,
  and creation buttons. Include empty chapters/acts, unassigned chapters, and
  clearly marked inactive scenes.
- Retain Corkboard, Outliner, and Board alongside Structure. Corkboard freeform
  dragging still changes visual coordinates, not manuscript reading order.
- Use planning metadata without loading all prose. Show chapter Description as
  a summary, kept distinct from its printed subtitle.

## Find, replace, and history

- Default to the current writing projection, including filtered/selected runs.
  Offer explicit whole-book/project scopes. Capture participating windows'
  pending content before forming a search snapshot.
- Include dirty/unsaved and offscreen scenes. Results carry book/scene identity,
  UTF-16 text offset/length, and revision; activation reveals/selects the exact
  match. Revalidate stale results before replacement.
- Matches span inline markup, not scene breaks. Preserve case/whole-word/regex
  options, literal replacement semantics, and the two-second regex timeout.
- Provide next/previous, Replace current, and Replace All. Prose Replace All is
  one logical undo action across target scenes, including wider book/project
  scope. Do not erase unrelated collaborators' edits.
- History outlives mounted DOM and expensive service bindings. Use writer and
  transaction identity for cross-scene undo/redo, structural actions, and replace.
  Whole-scene snapshot restoration is not collaborative undo.
- When a later collaborator structural edit makes an inverse unsafe, preserve
  their work and explain the blocked undo instead of forcing an earlier state.
- Preserve existing optional notes/Codex search and notes replacement recovery.
  Comments and Codex remain search-only where they are search-only today.

## Architecture and feasibility gate

Extend the current engine with one heavyweight runtime and continuous editing
surface per writing pane, stable scene-aware ownership, and separate scene
files. Scopes are projections over that document. Retain the mobile scene adapter.

Alternatives: PR #64's separate iframes are cheaper but lack native cross-scene
selection; engine replacement conflicts with the chosen preservation approach;
fully virtualized prose requires logical selection/history independent of DOM.
Start with lightweight scene prose and selectively activate expensive features.
Add prose eviction only if measurements require it and its selection/history
behavior is proven first.

Before production integration, demonstrate cross-scene mouse/keyboard selection,
copy/format/delete, persistent undo, IME, annotations, scope changes, remote edits,
delayed/failed saves, and correct active-scene extension context. Preloading
content must not emit a scene-opened activation.

Use synthetic 100/500/1,000-scene fixtures culminating in **1 million words**,
including long scenes, formatting, images, and comments. Typing-response p95 must
be **under 50 ms** on recorded reference hardware/OS/runtime versions. Measure
input event to the next rendered frame while scrolling/search/background analysis
runs; average handler duration is insufficient.

Traverse the largest book five times. Under equivalent idle/GC conditions,
rounds 3–5 retained heap must remain within 10% + 8 MiB of round 2, without new
editor runtimes or retained detached roots. The memory tolerance is a builder
acceptance choice. Record first-edit readiness, search/navigation latency,
service/DOM counts, and resident/heap memory separately. One heavy runtime per
pane is a hard limit; active proofing/media work is bounded by visible/active/
composing content, not total scene count.

Use content-free metrics and isolated desktops for Electron checks. A failed
gate reopens architecture; do not lower targets, silently replace the engine,
or drop a required behavior to proceed.

## Saving, collaboration, and compatibility

- Separate passive content fetching from activation: existing `scenes/read`
  raises SceneOpened. Retain its SDK behavior; active scene must follow the
  caret/focused pane, not prefetch/search.
- Converge desktop prose on one scene-document registry/write-ownership path.
  Preserve capture-before-unmount, expected hashes, serialized writes, epochs,
  conflicts, retained retries, and shutdown vetoes.
- Local multi-scene saves and structural changes require recoverable compound
  commits. Per-file atomic replacement and current WorkspaceCoordinator do not
  roll back partial structural failures. Validate first, journal affected data,
  and retain inverses; do not chain unrelated mutation RPCs from the renderer.
- Shared prose uses collaborative channels rather than ordinary scene-file
  writes. Keep per-writer origins/history independently of mounts. Respect
  connectivity requirements for structure and retain failed/unsent publication.
- Pin composition and selection work. Two panes showing one scene share document
  ownership, not competing autosave caches, and retain independent carets/scopes.
- Preserve single-scene RPC/API compatibility and mobile builds/file round-trips.
- Migrate both recursive pane layouts and named workspace layouts. Legacy
  Manuscript prose routes/commands reopen Write at Manuscript scope. Preserve
  planning access, pane trees, and all unrelated saved layout choices.
- Preserve scene tabs, tear-off windows, draft/project switches, extension
  commands, selected-scene runs, filters, diagnostics, and focus mode.

## Feature parity and verification

Preserve paragraph styles/lists/alignment/inline marks, links/images, comments,
footnotes, proofing, mentions/autocomplete/peek, completion lists, slash/extension
actions, replacements/dialogue correction, dictation, suggestions, read aloud,
readability, snapshots, reading comfort, page view, typewriter scrolling, compose
dimming, font/book width, zoom, and themes. PR #64's disabled stacked page view and
typewriter behavior are not accepted losses.

Use design tokens, SVG/Lucide icons, all three locales with correct diacritics,
manual and applicable README updates. Check release tags and consolidate final
user-visible behavior under Unreleased Added; leave published sections unchanged.
Never log prose, titles, summaries, query content, or filesystem paths.

Maintain 100% Core/SDK/Backend line coverage. Use Node/backend tests, typecheck,
desktop/mobile builds, source doctors, and aislop. Electron E2E runs only on
isolated runners; never set `NOVALIST_E2E_ALLOW_DESKTOP=1` locally to bypass that
rule. Planning does not authorize implementation, publishing, merging, or an
interactive-desktop test run.
