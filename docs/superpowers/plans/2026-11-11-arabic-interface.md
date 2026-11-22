# Arabic Interface Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Work in the existing checkout; the user explicitly requires one branch and no worktrees.

**Goal:** Integrate the Arabic contribution from #78 while preserving the unified editor and independent content direction.

**Architecture:** Existing locale discovery loads the new translation. Interface language controls document direction and logical chrome layout; content keeps the existing per-paragraph direction and writing-language settings. Adapt contributed styles to current components and tokens, and correct pointer math for mirrored panels.

**Tech stack:** React, i18next, TypeScript, native editor JavaScript/CSS, C#, headless Playwright and Node tests.

**Spec:** [Arabic interface design](../specs/2026-11-11-arabic-interface-design.md).

## Global constraints

- Same normal checkout and branch; no worktrees, pushes or user-project changes.
- Preserve #77 content direction, authored alignment, shortcuts, undo and unified editor routing.
- No new dependencies, emoji, hardcoded design sizes or global keyboard monkey patches.
- Test with synthetic data in headless browsers. Update localization manual, README and Unreleased capabilities.

## Tasks

- [x] **Translation:** Audit and adapt contributed `ar.json`, translate the current branch's missing keys, fix placeholders/semantic keyword isolation and add locale regression tests.
- [x] **Interface:** Set/reset document direction with language; recognize Arabic OS locales; report Arabic in Language Packs. Adapt RTL layout styles, panel and split dragging; test actual components and language reversal.
- [x] **Editor integration:** Propagate interface language separately from writing language into native editor documents. Mirror editor controls/metadata while preserving prose direction, alignment, zoom and serialization; add headless regressions.
- [x] **Integration review:** Run locale/source checks, scoped quality scan, complete headless RTL/editor tests, typecheck and builds. Inspect Arabic screenshots and review final diff. Update user docs with contribution credit and evidence.

## Review focus

- Arabic UI over English prose, and English UI over Arabic prose.
- Live Arabic-to-German/English switching without stale direction or editor reconstruction.
- Mirrored side-panel and split drag signs, and coordinate-positioned overlays.
- Translation placeholders, nested isolates and non-display arrays.
- Existing unified editor available from the normal workspace launcher.

## Verification — 2026-11-11

- Arabic has all 4,235 current English keys, its native language name, and 68 additional plural forms: 4,304 keys total. Six locale tests cover placeholders, balanced isolates, semantic role matching and all Arabic plural categories.
- Complete headless writing/RTL suite: **146 passed**. Relevant Node suite: **111 passed**. Backend language-pack tests: **13 passed**; Arabic startup/saved-settings tests: **3 passed**.
- Full TypeScript check, frontend build, backend build, and all eight source checks passed. Changed-file quality scan: **100**, zero errors or warnings.
- Independent review caught and verified fixes for Focus mode hover edges and comment proofing language. Reviewer separately exercised 18 direction/page/zoom combinations with comments visible.
- Visually inspected the actual unified editor with Arabic controls and synthetic prose. No user project or interactive Electron session was used.
- Logs and screenshots are retained locally under `.superpowers/sdd/2026-11-11-arabic-interface/`.
