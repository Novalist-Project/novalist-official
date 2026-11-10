# Manuscript writing and Structure planning

On desktop, **Write → Manuscript** presents the active book and draft as one continuous, editable document. Each writing pane can independently narrow to **Chapter** or **Scene** scope.

Planning lives in **Plan → Structure**, with **Structure**, **Corkboard**, **Outliner**, and **Board** modes. iPhone and iPad retain the existing Manuscript view and its planning modes.

![The Manuscript corkboard](images/manuscript.png)

## Opening Manuscript scope

Choose **Write**, then **Manuscript** in the scope selector. The **Manuscript** command in Go or the command palette, and `Ctrl+5` (Cmd on macOS), select this same scope. Saved pane and workspace layouts retain each writing pane's scope; detached writing windows carry it with them.

## The toolbar

In Plan, the mode switch selects **Structure**, **Corkboard**, **Outliner**, or **Board**. In Write, the scope selector chooses how much prose the pane displays.

Open **Filter** to narrow the writing and planning views:

- **Scene stage** selects each scene's own revision stage, including stages you configured for the book. Scenes in the same chapter can have different stages.
- **Character**, **Place**, and **Thread** narrow by the scene's cast, viewpoint, and plotlines.

Filters combine, so selecting a scene stage and a character includes only scenes matching both. **Any** removes one restriction; **Clear** removes all of them. Name a filter and press Enter to save it as a preset. The filter stays selected when you move between Manuscript and Timeline.

Older presets that explicitly filtered chapter status keep that restriction. It appears as **Legacy chapter status** with a remove button. Clear it to filter only by scene stage; new filters have no chapter-status picker.

Changing the displayed run retains pending prose and undo history. Selected scenes take precedence over ordinary filters; a Smart List or selection with no matching scenes stays empty. A limited run is labelled in Write. **Show whole manuscript** clears the run and filters and selects Manuscript scope.

## Manuscript mode

The default writing scope displays chapters and scenes in reading order:

- **Chapter headings** show the chapter title.
- Each scene has a live **word count** and a **synopsis** below it in the margin. Synopses start collapsed, remember their expansion locally, and can all be hidden or shown from the writing toolbar. Scene titles remain in the binder, tabs, inspector, and Plan.
- The scene prose itself is **editable in place**. Type directly into the manuscript; changes save automatically after a short pause, exactly like the editor.

Select, copy, format, or delete across scene boundaries and undo without leaving the flow of the book. Changing scope preserves the current documents and history.

The column follows **Settings → Editor → Book Page Width**, including the selected page format, custom text width and book font. With Book Page Width off, it fills the available pane and uses your editor font. Changes apply while the manuscript is open. Hold `Ctrl` and scroll the mouse wheel to zoom the text and column together, preserving line breaks. Zoom is shared with the scene editor for the current session and leaves font and page settings unchanged. An enlarged column can be scrolled horizontally.

Zoom follows the caret and keeps it visible. With **Typewriter Scrolling** enabled, zoom places it at the selected top, middle or bottom position; otherwise it preserves its vertical screen position where scrolling allows.

## Structure mode

Open **Plan → Structure** to arrange the book's acts, chapters, and scenes. Edit a chapter summary below its heading, or a scene synopsis below its card. Click a scene title to continue writing it.

Use **New act** to create an ordered chapter group, including an empty group you will fill later. Drag a chapter into an act to assign it; moving an act moves its chapters together. **Rename act** retains its chapter assignments and existing targets and dates. **Remove act** keeps its chapters in place as unassigned chapters.

The desktop chapter dialog selects from these acts. Changing a chapter's act moves it into that group; clearing the assignment places it outside its former group without splitting that act. Dragging a chapter in the Binder adopts the destination chapter's act. These moves share the same undo history as Structure.

Drag scenes or chapters to change their reading order. Check several cards to move them together. Every card also has a **Move** control: choose the destination and whether to place the selection before, after, or inside it. This offers the same moves with the keyboard. **Undo** and **Redo** use the writing session's history, including structural changes made in Write.

**New scene** adds a scene to the chosen chapter. **Insert chapter** creates a named chapter with one empty scene. When an older project contains incompatible act assignments, **Review act grouping** shows the existing and proposed chapter order before applying any regrouping.

## Corkboard mode

Open **Plan → Structure → Corkboard** for these cards.

Each scene becomes a card on a board, grouped under its chapter title. Each card shows:

- **Scene title**.
- **Synopsis** — editable directly on the card; the change is saved when you click away.
- **Word count**.

Corkboard mode is ideal for planning passes: skim the whole book as synopses and fill in the summaries you skipped while drafting.

### Colouring the cards

**Colour by** decides what the coloured band down the left edge of a card means:

- **Label** — the scene label you set yourself, and the default. See [Scene labels](#scene-labels).
- **Viewpoint** — the scene's POV character.
- **Act** — the act its chapter belongs to.
- **Scene stage** — uses the colour configured for each scene's stage; scenes without a stage have no band.
- **Nothing** — no band.

Apart from Label, the colours are derived: Novalist picks a stable colour from the value itself, so a dimension works the moment there are values to colour and never needs setting up. The same viewpoint is always the same colour. A scene with nothing said — no viewpoint, no act — gets no band rather than being coloured as though a decision had been made.

The choice applies to both card arrangements and lasts for the session; it is a way of looking at the book, not a property of it.

### Arranging cards freely

By default the cards sit in reading order, grouped by chapter — which is the arrangement the binder already shows you. Tick **Arrange freely** in the toolbar to put them where you like instead.

- Drag a card anywhere by its body. The title and the synopsis box stay clickable, so dragging never eats an edit.
- Cards from every chapter share one board. Putting scenes from three different chapters side by side is the point.
- Positions are saved with the book, per scene, so the arrangement is still there next week and on your other machine.
- A scene you have never placed takes the slot it would have had in reading order, so turning the mode on shows you the book as it stands rather than a pile in the corner. New scenes appear the same way.
- **Back to reading order** forgets the arrangement entirely. The board goes back to tracking reading order, including for scenes you add or reorder later.

Arranging cards never changes the order of the book. It is a place to think, not an edit to the manuscript — to actually reorder scenes, drag them in the [binder](02-interface-overview.md#the-binder) or use the [Board](#board-mode).

## Outliner mode

A table with one row per scene and these columns:

- **Chapter**
- **Scene**
- **Synopsis** — editable inline; saved when you leave the field.
- **POV** — editable inline; saved when you leave the field.
- **Words**

The outliner is useful for:

- Bulk editing synopses.
- Auditing and correcting POV assignments (Smart Lists filter on this field).
- Eyeballing word counts to find unusually short or long scenes.

## The Target column

The outliner's last built-in column is each scene's [word target](04-chapters-and-scenes.md#word-targets). Type a number to set one, clear the field for none. This is the fastest place to set targets across a run of scenes, since you can tab straight down the column.

Any [scene field](#your-own-scene-and-chapter-fields) you marked **Show as a column in the outliner** gets its own column after this one, editable the same way.

## Scene labels

**Settings → Scene labels** defines the labels a scene in this book can carry — "needs a beta read", "cut but keeping", one per thread, whatever you find yourself wanting to flag. Each has a name and a colour.

Right-click a scene in the binder and pick a label, or **No label** to clear it. With several scenes selected, the entry labels all of them and says how many. A labelled scene's corkboard card is drawn with that colour down its edge.

Removing a label from the list takes it off every scene carrying it, so a colour never outlives the thing it meant.

## Reading a chosen set of scenes

Manuscript mode normally stitches the whole book (or scenes matching the active filters) into continuous text. Select scenes anywhere — the binder, the corkboard, the outliner, the Calendar — and the bulk bar gains **Read as one**: the Manuscript view switches to just those scenes, in reading order, as continuous prose.

This is how you read one POV's thread end to end, or the scenes a [Smart List](16-smart-lists.md) found, and hear whether the run holds together. Shared filters are ignored while a chosen set is being read — you picked the scenes, so they are the scenes.

The toolbar labels the limited scene run and provides **Show whole manuscript** to leave it.

## Board mode

**Board** lays the book out as columns of scene cards, grouped by something you choose rather than always by chapter:

- **Scene stage** (the default) - one column per [stage](04-chapters-and-scenes.md#scene-stages). This is the revision view: what is drafted, what is revised, what nobody has looked at.
- **Chapters** - one column per chapter.
- **POV** - one column per point-of-view character in the book.
- **Any scene field of your own** that is text, a number, yes/no or a choice.

There is always a **Not set** column at the end holding the scenes that have no value for whatever you grouped by. It is deliberately never hidden: a board that quietly drops the untriaged scenes reads as though the work is finished.

**Dragging a card into another column writes that field.** Drop a scene in Revised and its stage becomes Revised; drop it in another chapter and the scene moves there; drop it in a POV column and its POV is set. That is what makes the board different from a filter - you rearrange the book by rearranging the cards.

Clicking a card's title opens the scene; ctrl-click and shift-click select cards the same way they do everywhere else, and the bulk bar appears once two are selected.

## Your own scene and chapter fields

Novalist ships a fixed set of things it knows about a scene - title, synopsis, POV, date, word count, stage. **Settings -> Scene and chapter fields** lets you add your own to every scene or every chapter of the book: tension as a number, which revision pass it is on, a yes/no for "needs a fact check", a date, or a pick from a list you define.

Fields are typed, which is the point of having them rather than overloading tags. A number sorts and totals as a number; a choice stays one of your choices; a date is a date. Values live with the scene or chapter in the project, so they travel through Git and to another machine like everything else.

Fill them in from:

- The **Properties** tab of the inspector, for the scene you have open.
- The **Chapter** dialog, for chapter fields.
- The outliner, for any scene field you ticked **Show as a column in the outliner**.

Removing a field also removes what you filled in for it, everywhere. That is deliberate: a value with no field left to explain it is invisible in every view yet still travels with your project, and would reappear under any later field that happened to reuse its name.

## Selecting several scenes

Corkboard cards and outliner rows carry the same multi-select as the binder: ctrl-click (Cmd-click) a scene title to add it to the selection, shift-click to extend the range, and a bulk bar appears at the bottom once two or more are selected. The selection is shared with the binder and the Calendar. See [Chapters and scenes](04-chapters-and-scenes.md#selecting-several-scenes-at-once).

## Where to go next

- [Editor](05-editor.md) — for actually writing the scenes.
- [Smart Lists](16-smart-lists.md) — saved scene queries over status, POV, and tags.
- [Export](20-export.md) — when you want a file outside the app.
