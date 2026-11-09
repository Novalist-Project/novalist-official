# One continuous writing surface with separate scene ownership

Extend Novalist's existing editor so each writing pane provides one continuous
editing surface across scenes. Scene, Chapter, and Manuscript are independent
per-pane scopes over the same writing; retain scene identities, separate scene
files, and existing project compatibility. The user requires cross-scene text
selection, formatting, deletion, find/replace, and undo that survives scrolling.
The separate-iframe approach in PR #64 cannot provide native cross-scene text
selection, even though it already mounts editors near the viewport.

Prove the approach before production integration, using up to 1,000 scenes and
1 million words, including annotations and collaborative editing. Start with
lightweight prose in one surface and activate expensive services selectively;
add offscreen prose eviction only if measured performance requires it. Document
ownership, pending writes, selection, and transaction history must outlive any
view or service mount. Preserve each collaborator's work during undo and recovery.

This extends [ADR 0006](0006-extend-existing-editor-for-collaboration.md), not an
editor-engine replacement. If the experiment cannot preserve the required
behavior and responsiveness, report the failing case and revisit the design
before replacing the engine or dropping capabilities. Runtime types and exact
module boundaries in the implementation plan are provisional until that gate.
