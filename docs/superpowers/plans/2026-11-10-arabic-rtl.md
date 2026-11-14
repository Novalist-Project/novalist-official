# Arabic and RTL Content Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the tasks and independently review the result. Steps use checkbox tracking.

**Goal:** Implement issue #77 natively for Arabic writers without changing the interface layout.

**Architecture:** Native automatic direction on individual content blocks, CodeMirror per-line direction, content-only logical CSS and a shared pure shortcut resolver. Preserve the unified editor's existing font-size zoom and scene storage model.

**Tech Stack:** TypeScript/React, browser contenteditable, CodeMirror 6, CSS, Node tests and headless Playwright.

**Spec:** `docs/superpowers/specs/2026-11-10-arabic-rtl-design.md`

## Global constraints

- Use the existing consolidated worktree/branch; no new branch, dependency, push or user-project access.
- Keep interface language and layout unchanged. No Arabic locale or keyboard-event shim.
- Respect existing explicit direction/alignment; composition and AltGraph must keep working.
- Use design tokens, existing scene sanitization, and synthetic tests. Do not run interactive Electron tests.
- Update the user manual and Unreleased changelog once for the final capabilities.

## Review focus

- Arabic paragraphs adjacent to English, numbers and punctuation retain independent ordering and alignment.
- New paragraphs, pasted lists and saved/reloaded scenes retain direction without polluting chrome or changing selection/history.
- QWERTZ/AZERTY and custom hotkeys preserve logical Latin bindings; Arabic fallback never hijacks composing/AltGraph input.
- Dropdown direction follows the selected value rather than the first available option; Wiki Arabic letters remain joined.
- Narrow panes and zoomed paper layouts do not hide text horizontally, and LTR layout measurements remain valid.

### Task 1: Layout-independent shortcut handling

**Files:** new `app/src/renderer/public/editor/shortcut-key.js` and declaration; `shell/hotkeys.ts`, `views/settings/HotkeysCard.tsx`, editor `clipboard-focus.js`, `content-input.js`, `entity-events.js`, `writing-transactions.js`, `writing-selection.js`, `manuscript-editor.js`, editor HTML script lists, `views/editor/editorActionMessages.ts`, `collaboration/CollaborativeScene.ts`, `shell/SceneNotesWindow.tsx`, dedicated Markdown shortcut extension and tests.

**Interface:** one pure `getShortcutKey(event)` resolver returns a comparable key or null for composition/AltGraph. Shell matching, recording, forwarding and editor actions consume it. Task 3 imports the Markdown extension; Task 2 requests any shared HTML/paste edits from this task to avoid concurrent edits.

- [x] Add failing tests for Arabic modified keys, native shortcut reservation, forwarded save/find, undo/redo/formatting, custom capture, Latin layouts, composition and AltGraph.
- [x] Implement the shared resolver and wire every relevant writing/application handler without mutating events or intercepting native clipboard behavior.
- [x] Run the focused tests and report exact results; preserve existing hotkey tests.

### Task 2: Direction-aware prose and zoom

**Files:** editor direction helper, `writing-document.js`, `content-input.js` (coordinate with Task 1), `typography.js`, content CSS and legacy/unified zoom as needed; new `app/e2e/writing-rtl.spec.ts` plus Node tests.

**Interface:** apply automatic direction to prose blocks on load/insert/input while preserving explicit valid direction. No direction on editor chrome, scene wrappers or page wrappers. Existing serializer remains authoritative.

- [x] Add failing browser tests for Arabic/English paragraphs, explicit direction/alignment, Enter, paste, lists and save/reload; add overflow tests for narrow/normal/book/page writing at 50%, 100% and 200%.
- [x] Implement native direction semantics and logical prose spacing; preserve valid direction in paste through Task 1's shared-file owner.
- [x] Run new tests and relevant appearance/page parity regressions. Correct supported legacy zoom overflow without regressing unified font zoom.

### Task 3: Fields, Markdown, Codex and Wiki

**Files:** `styles/base.css` or scoped shared content stylesheet; `shell/MarkdownEditor.tsx`, `shell/markdownEditor.css`; Codex `SharedFieldControl.tsx`, `EntityDetailFields.tsx`, `EntityTable.tsx` and user-valued lists; Wiki `WikiArticle.tsx`, `WikiInfobox.tsx`, `wiki.css`; new real-component headless fixture/spec.

**Interface:** native text control/content direction; dropdown direction from the selected display label. CodeMirror `EditorView.perLineTextDirection.of(true)` and Task 1's shortcut extension work together. UI layout never inherits user-content direction.

- [x] Add failing real-component browser tests for Arabic/Latin input, changed dropdown selection, Markdown caret/typing and Wiki paragraph/drop-cap behavior.
- [x] Implement content-only direction and logical styles, isolate code and prevent Arabic drop caps. Wire the shared Markdown shortcut extension.
- [x] Run focused browser tests and typecheck changed components.

### Task 4: Integration and verification

**Files:** `app/playwright.writing-native.config.ts`, `docs/manual/05-editor.md`, `docs/manual/06-codex.md`, `docs/manual/26-hotkeys.md`, `README.md` if headline changes, `CHANGELOG.md`, plan checkboxes and validation notes.

- [x] Integrate the new headless specs and verify the final behavior against every issue requirement.
- [x] Run `npm run typecheck`, affected Node tests, writing-native browser suite, build, repository source checks and scoped aislop.
- [x] Independently review the combined changes, address findings and rerun affected checks.
- [x] Update manual/changelog and record exact results and limitations. Leave a reviewable local implementation; no remote changes.


## Implementation and validation — 2026-11-10

Completed locally on `feat/unified-writing-workspace`, in its existing consolidated worktree.

- `prose-direction.js` / `.css` provide native automatic direction. Shared `scene-html.js` initializes loaded prose; an incremental observer handles added blocks and changes inside lists/quotations. Ordinary paragraph typing does not scan the manuscript. Runtime inference is stripped from saved HTML; explicit `auto`, `ltr`, `rtl` and CSS direction/alignment survive.
- `shortcut-key.js` is shared by shell, native editor, collaboration, detached notes and Markdown command handling. Native clipboard operations remain native; composition, AltGraph and Latin layout bindings remain intact.
- `ContentSelect`, CodeMirror line direction, Codex content controls, scene metadata and Wiki article rendering support mixed content without mirroring the shell. Wiki nested/loose lists, joined Arabic lead text, code and table alignment are covered.
- Unified font-size zoom remains in place. Legacy RTL zoom now fits the available width. Native select-all/cut/paste also retains the destination scene and survives serialization/reload.

Final verification:

| Check | Result |
| --- | --- |
| Complete `playwright.writing-native.config.ts` suite | 124 passed, headless Chromium |
| Affected Node suites, including legacy manuscript | 98 passed |
| `npm run typecheck` | Passed: renderer, main and E2E |
| `npm run build` | Passed |
| `python tools/check-source.py` | All 8 checks passed |
| Scoped aislop | Score 100; 0 errors, 0 warnings |
| `git diff --check` | Passed |

Independent review findings were corrected with failing-then-passing regressions: nested containers, inherited alignment/direction, Wiki loose lists, clean serialization and the inherited full-scene clipboard target defect. Original IME/readability exact-HTML assertions were retained. Actual component screenshots were visually inspected with synthetic Arabic/English text.

Validation used synthetic Node/browser fixtures. No interactive Electron run or user project was needed. Changes remain local and uncommitted; the production build is ready for normal startup.
