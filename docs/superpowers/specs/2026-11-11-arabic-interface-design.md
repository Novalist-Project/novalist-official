# Arabic interface and RTL integration

Source: [issue #78](https://github.com/Novalist-Project/novalist-official/issues/78), contributed by Ammar-Banna in the supplied Arabic RTL Support ZIP. Builds on the content support from #77.

## Behavior

- Bundle Arabic (`ar`, العربية) in Settings alongside English, German and Simplified Chinese. Match Arabic OS locales on first launch. Language Packs reports the bundled interface separately from analysis lexicons.
- Choosing Arabic sets the interface's direction to RTL. Choosing an existing LTR language restores LTR immediately. The contribution is adapted to current components and design tokens; it is not installed as a global keyboard patch.
- Navigation, inspector, menus and resize handles follow interface direction. Pointer resizing follows the visible edge. Code, shortcuts and mathematical/chart coordinates keep their intended ordering.
- Writing language remains independent of interface language. Mixed paragraphs retain their own direction, authored alignment and saved HTML. Editor chrome follows interface direction without forcing every paragraph right or changing spelling settings.
- Preserve the contributed Arabic wording and intentional balanced Unicode isolates in display strings. Complete missing current keys, repair placeholders and remove isolates from semantic relationship keywords.
- The unified editor, existing project files, zoom, selection and undo remain available in the same checkout and branch.

## Validation

Headless browser tests cover language selection and reversal, actual component geometry and dragging, editor UI language versus writing language, mixed prose and unchanged serialization. Locale checks cover key/placeholder parity, balanced isolates and relationship keywords. Run existing RTL/editor browser and Node tests, typechecks, frontend/backend builds, source checks and scoped quality checks. Use synthetic fixtures; do not open user projects.

## Constraints

Use the normal `D:\git\novalist-official` checkout on `feat/unified-writing-workspace`; create no worktrees. No new dependencies, external publication or desktop Electron runs. Interface translation does not add an Arabic scene-analysis lexicon or translate third-party extensions.
