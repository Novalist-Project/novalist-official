# One continuous writing surface with separate scene ownership

Extend Novalist's existing editor so each writing pane provides one continuous
editing surface across scenes. Scene, Chapter, and Manuscript are independent
per-pane scopes over the same writing; retain scene identities, separate scene
files, and existing project compatibility. The user requires cross-scene text
selection, formatting, deletion, find/replace, and undo that survives scrolling.
The separate-iframe approach in PR #64 cannot provide native cross-scene text
selection, even though it already mounts editors near the viewport.

The implementation retains lightweight scene prose in one editable root per pane
and activates expensive services selectively. A shared scene registry, pending
writes, logical selections, and transaction history outlive view and service
mounts. Collaborative scenes retain their Yjs documents and writer-scoped undo;
scene files and identities remain separate. Offscreen prose eviction is not part
of this implementation.

Final acceptance requires the production 100/500/1,000-scene matrix up to
1 million words, including annotations and collaborative editing. This gate is
still in progress; historical adapter experiments are not production acceptance.
See the [validation record](../research/unified-writing-validation.md).

This extends [ADR 0006](0006-extend-existing-editor-for-collaboration.md), not an
editor-engine replacement. If the experiment cannot preserve the required
behavior and responsiveness, report the failing case and revisit the design
before replacing the engine or dropping capabilities. Neither change is authorized
by this decision.
