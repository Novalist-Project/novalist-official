# Novalist

Novalist is a writing workspace for books and their story worlds.

## Language

**Manuscript**:
The written content of a book, arranged in chapters and scenes.

**Act**:
An optional, ordered group of consecutive chapters within a manuscript. A chapter
belongs to at most one act, and chapters may remain unassigned.

**Writing scope**:
The portion of a book shown for writing: one scene, one chapter, or the manuscript.
Changing scope changes how much of the same writing is visible.

**Scene synopsis**:
A short summary of what happens in a scene, kept separate from its prose and working notes.

**Scene break**:
A structural boundary between scenes in a manuscript. It is distinct from a
decorative separator or a paragraph's visual style.

**Structure board**:
A planning view that shows acts, chapters, and scene summaries in manuscript
order. Moving an item changes the manuscript's reading order.

**Filtered writing**:
A writing view limited to chosen scenes or scenes matching a filter. Hidden
scenes remain in the manuscript and are outside edits made in this view.

**External project folder**:
A Novalist project folder chosen by the writer outside the app's private storage. Edits are saved back to that folder, rather than imported into a separate project.

**Linked cloud project**:
A Novalist project connected to a folder in the writer's cloud account. The writer can work on a downloaded copy while offline, and pending changes are synchronized with that same folder when connected.
**Hosted project**:
A shared Novalist project whose connected clients communicate through a packet
relay. The relay does not persist project data; joining requires an online host.
See [ADR 0007](docs/adr/0007-relay-only-collaboration.md).

**Steam collaboration session**:
A shared project editing session joined through Steam that remains available while its hosting writer is online.

**Project owner**:
The collaborator who controls a shared project's membership and deletion.

**Local project copy**:
A collaborator's retained copy of a shared project, available to open and export after collaboration ends.

**Independent project copy**:
A separate project created from a collaborator's local copy, owned by that collaborator and independent of the original shared project.

**Recovered scene copy**:
A separate copy of edits preserved when the shared scene was deleted concurrently. It does not automatically restore the deleted scene.

**Codex entry**:
A named character, location, item, lore entry, or member of a custom type in a book or its World Bible.

**Custom entity type**:
A writer-defined category of Codex entries with its own fields and optional images, relationships, and sections.

**Reference list**:
A field containing multiple distinct references to Codex entries of one selected entity type.

**Multiline text field**:
A plain-text field that preserves line breaks for longer descriptions.

**Dismissed proofing issue**:
A spelling or grammar finding ignored for one occurrence until its scene is edited or reopened. Dismissing a finding does not add its word to the dictionary.

**Chapter story date**:
The in-world date or date range of a chapter. Scenes without their own dates or relative timing inherit it, falling back to the act's date when the chapter is undated.

**Act timeline date**:
The act's explicit story date, or otherwise the story date of its first chapter in manuscript order. An act with neither remains undated.
