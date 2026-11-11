# Arabic and RTL content support

Source: [issue #77](https://github.com/Novalist-Project/novalist-official/issues/77).

The writer confirmed that this is content support, with the existing interface layout retained. Arabic prose, names and fields must work alongside English without an extension, keyboard shim or translated interface.

## Behavior

- Each prose paragraph chooses its direction from its first strong character. Mixed Arabic/English paragraphs retain normal Unicode ordering. Explicit imported `dir="ltr"`/`dir="rtl"` and manual alignment survive editing, paste and saving.
- Newly typed paragraphs, lists, headings and quotations use the same behavior. Empty automatic paragraphs use the surrounding default until text establishes their direction. No new direction setting is necessary for this change.
- Scene metadata, Codex fields and user-valued dropdowns, Markdown editing and Wiki reading handle Arabic content independently of the interface language. The shell, navigation and editor rails retain their layout.
- RTL Wiki text has no Latin-style floating drop cap, which would separate joined Arabic letters. Content indentation and quote rules follow the content direction; code remains LTR.
- Modified shortcuts work on Arabic and other non-Latin keyboards throughout the writing surfaces, shell and shortcut recorder. Existing logical Latin-layout shortcuts continue to work. Composition and AltGraph text entry are not intercepted. Keyboard events are never monkey-patched or rewritten.
- Native copy/cut/paste and selection remain native. Custom formatting/history/application actions use the same normalized key policy, including events forwarded out of editor frames.
- Writing zoom reflows Arabic text within the pane. Keep the unified editor's font-size zoom; verify ordinary, book-width and page layouts at multiple zoom levels. Correct any remaining legacy RTL zoom overflow in supported writing paths.

## Approach

Use native HTML direction semantics on content blocks, CodeMirror's per-line direction support, logical content CSS, and one shared pure shortcut-key resolver. A whole-app RTL switch would change a layout the writer explicitly chose to keep. A global keyboard shim would alter native typing and hide inconsistent handlers; normalize only inside the application's shortcut handling instead.

The key resolver preserves printable Latin keys, using physical `KeyA`–`KeyZ`/digit positions only for modified non-Latin characters. Named navigation keys stay unchanged. Explicit direction is data; automatically inferred direction does not require project-file migration.

## Constraints and verification

Keep the consolidated `feat/unified-writing-workspace` branch and existing worktree. No push, extra worktree, new dependencies, Arabic locale, interface mirroring or project migration. Do not touch the running writer's project. Use synthetic Node and headless browser tests; interactive Electron tests require specific consent.

Test mixed content, punctuation, input/Enter/paste, explicit direction/alignment persistence, list markers, real caret/selection, live dropdown values, Arabic keyboard shortcuts, Latin keyboard compatibility, composition/AltGraph, and zoom overflow. Existing writing tests, typechecking and repository source checks must remain green.

References: [HTML direction](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/dir), [Unicode bidi CSS](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/unicode-bidi), and installed CodeMirror `EditorView.perLineTextDirection` API.
