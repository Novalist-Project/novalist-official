'use strict';

function queueWritingChanges() {
    const state = window.NovalistWritingDocument;
    if (!state.enabled || window.NovalistEditorState.isComposing) return;
    window.collectWritingMutations(state.observer?.takeRecords() || []);
    const changes = [];
    for (const id of state.dirty) {
        const entry = state.scenes.get(id);
        if (!entry) continue;
        const afterHtml = window.serializeWritingScene(id);
        if (afterHtml === entry.snapshot.html) continue;
        const { bookId, draftId, chapterGuid, sceneId, html, hash, revision } = entry.snapshot;
        changes.push({ ref: { bookId, draftId, chapterGuid, sceneId }, expectedRevision: revision,
            expectedHash: hash, beforeHtml: html, afterHtml });
        entry.snapshot = { ...entry.snapshot, html: afterHtml, revision: revision + 1 };
        entry.pendingProseRevision = revision + 1;
        entry.normalized = window.cleanContentRoot(entry.root);
    }
    state.dirty.clear();
    if (!changes.length) return;
    const annotationTransfers = state.annotationTransfers?.splice(0) || [];
    state.pending.push({ id: crypto.randomUUID(), context: state.context, origin: state.origin,
        kind: state.kind || 'input', changes, annotationChanges: [],
        ...(annotationTransfers.length ? { annotationTransfers } : {}),
        beforeSelection: state.beforeSelection, afterSelection: window.getWritingSelection() });
    state.beforeSelection = window.getWritingSelection();
    state.kind = 'input';
}

function captureWritingChanges() {
    queueWritingChanges();
    return window.NovalistWritingDocument.pending.splice(0);
}

function writingSelectedRanges() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return [];
    const selected = selection.getRangeAt(0);
    const state = window.NovalistWritingDocument;
    const first = window.writingPointFromDom(selected.startContainer, selected.startOffset)?.sceneId;
    const last = window.writingPointFromDom(selected.endContainer, selected.endOffset)?.sceneId;
    const start = state.order.indexOf(first), end = state.order.indexOf(last);
    if (start < 0 || end < 0) return [];
    return state.order.slice(start, end + 1).map(id => {
        const root = state.scenes.get(id).root;
        const range = document.createRange();
        range.selectNodeContents(root);
        if (id === first && root.contains(selected.startContainer)) range.setStart(selected.startContainer, selected.startOffset);
        if (id === last && root.contains(selected.endContainer)) range.setEnd(selected.endContainer, selected.endOffset);
        return { id, root, range };
    });
}

function deleteWritingSelection() {
    const ranges = writingSelectedRanges();
    if (ranges.length < 2) return false;
    const state = window.NovalistWritingDocument;
    state.beforeSelection ||= window.getWritingSelection();
    for (const { id, root, range } of ranges) {
        state.dirty.add(id);
        range.deleteContents();
        if (!root.firstChild) root.replaceChildren(window.sceneContentFragment('<p><br></p>'));
    }
    const selection = window.getSelection();
    ranges[0].range.collapse(true);
    ensureWritingCaret(ranges[0].range);
    selection.removeAllRanges();
    selection.addRange(ranges[0].range);
    return true;
}

function ensureWritingCaret(range) {
    const root = window.writingSceneOf(range.startContainer);
    if (!root || !range.collapsed) return;
    const blocks = 'p,div,h1,h2,h3,h4,h5,h6,blockquote,li';
    if (range.startContainer === root) {
        const next = root.childNodes[range.startOffset];
        const child = next || root.lastChild;
        const block = child?.matches?.(blocks) ? child : child?.querySelector?.(blocks);
        if (block) range.setStart(block, next ? 0 : block.childNodes.length);
        range.collapse(true);
    }
    const element = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer;
    const block = element.closest?.(blocks);
    if (!block || !root.contains(block) || block.textContent || block.children.length) return;
    block.appendChild(document.createElement('br'));
    range.setStart(block, 0);
    range.collapse(true);
}

function writingBeforeInput(event) {
    const state = window.NovalistWritingDocument;
    if (!state.enabled || window.NovalistEditorState.isComposing || event.defaultPrevented) return;
    state.beforeSelection ||= window.getWritingSelection();
    const nativeSelection = window.getSelection();
    if (nativeSelection?.isCollapsed && nativeSelection.anchorNode === window.NovalistEditorState.editor) {
        window.restoreWritingSelection(window.getWritingSelection());
    }
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        event.preventDefault();
        window.sendMessage({ type: 'writingHistoryRequested', direction: event.inputType === 'historyUndo' ? 'undo' : 'redo' });
        return;
    }
    const ranges = writingSelectedRanges();
    const format = { formatBold: 'toggleBold', formatItalic: 'toggleItalic', formatUnderline: 'toggleUnderline' }[event.inputType];
    if (ranges.length > 1 && format) {
        event.preventDefault();
        window[format]();
        return;
    }
    if (ranges.length > 1 && !event.inputType.startsWith('format')) {
        if (window.NovalistEditorState.suggestionMode) return;
        deleteWritingSelection();
        if (event.inputType.startsWith('delete')) {
            event.preventDefault();
            window.NovalistEditorState.editor.dispatchEvent(new Event('input'));
        }
        return;
    }
    const current = ranges[0];
    if (!current || !current.range.collapsed || !event.inputType.startsWith('delete')) return;
    const prefix = current.range.cloneRange();
    prefix.selectNodeContents(current.root);
    const backwards = event.inputType.endsWith('Backward');
    if (backwards) prefix.setEnd(current.range.startContainer, current.range.startOffset);
    else prefix.setStart(current.range.endContainer, current.range.endOffset);
    if (!prefix.toString()) event.preventDefault();
}

function writingSelectedContent(root, range) {
    const container = document.createElement('div');
    container.appendChild(range.cloneContents());
    let ancestor = range.commonAncestorContainer;
    if (ancestor.nodeType !== Node.ELEMENT_NODE) ancestor = ancestor.parentElement;
    while (ancestor && ancestor !== root && root.contains(ancestor) &&
        ancestor.matches('a,b,strong,i,em,u,s,strike,span,sup,sub,code,mark,del,ins,font') &&
        !ancestor.hasAttribute('data-editor-chrome')) {
        const wrapper = ancestor.cloneNode(false);
        wrapper.append(...container.childNodes);
        container.appendChild(wrapper);
        ancestor = ancestor.parentElement;
    }
    container.querySelectorAll('[data-editor-chrome]').forEach(node => node.remove());
    window.stripRuntimeProseDirection?.(container);
    return container;
}

window.writingSelectedContent = writingSelectedContent;

function writingClipboard(event) {
    if (!window.NovalistWritingDocument.enabled || !event.clipboardData) return;
    const ranges = writingSelectedRanges();
    if (!ranges.length || window.getSelection().isCollapsed) return;
    const fragments = ranges.map(({ root, range }) => writingSelectedContent(root, range));
    event.preventDefault();
    event.clipboardData.setData('text/html', fragments.map(root => root.innerHTML).join(''));
    event.clipboardData.setData('text/plain', fragments.map(root => window.writingSceneText(root).replace(/\n$/, '')).join('\n'));
    if (event.type === 'cut') {
        if (window.NovalistEditorState.suggestionMode) window.markSelectionDeleted();
        else if (!deleteWritingSelection()) {
            const { root, range, id } = ranges[0];
            range.deleteContents();
            if (!root.textContent && !root.querySelector('img,hr,table')) {
                root.replaceChildren(window.sceneContentFragment('<p><br></p>'));
                const point = { sceneId: id, offset: 0, affinity: 'after' };
                window.restoreWritingSelection({ anchor: point, focus: point });
            }
        }
        window.NovalistEditorState.editor.dispatchEvent(new Event('input'));
    }
}

const writingRoot = window.NovalistEditorState.editor;
writingRoot.addEventListener('keydown', event => {
    if (!window.NovalistWritingDocument.enabled || window.NovalistEditorState.isComposing ||
        (!event.ctrlKey && !event.metaKey) || event.altKey) return;
    const key = window.NovalistShortcutKeys.key(event);
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.sendMessage({ type: 'writingHistoryRequested', direction: key === 'y' || event.shiftKey ? 'redo' : 'undo' });
}, true);
writingRoot.addEventListener('beforeinput', writingBeforeInput, true);
writingRoot.addEventListener('copy', writingClipboard);
writingRoot.addEventListener('cut', writingClipboard);
writingRoot.addEventListener('paste', () => {
    if (window.NovalistWritingDocument.enabled && !window.NovalistEditorState.suggestionMode) deleteWritingSelection();
}, true);
Object.assign(window, { queueWritingChanges, captureWritingChanges, writingSelectedRanges, deleteWritingSelection, ensureWritingCaret });

function writingIsolatedCommand(root, range, command, args) {
    const editor = window.NovalistEditorState.editor;
    const attributes = [editor, root].map(node => node.getAttribute('contenteditable'));
    try {
        editor.contentEditable = 'false';
        root.contentEditable = 'true';
        root.focus({ preventScroll: true });
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        command(...args);
    } finally {
        [editor, root].forEach((node, index) => {
            if (attributes[index] === null) node.removeAttribute('contenteditable');
            else node.setAttribute('contenteditable', attributes[index]);
        });
    }
}

function writingFormatCommand(command, args, isolate) {
    const state = window.NovalistWritingDocument;
    if (!state.enabled) return command(...args);
    const selection = window.getWritingSelection();
    state.beforeSelection ||= selection;
    state.kind = 'format';
    const ranges = writingSelectedRanges();
    if (ranges.length < 2 && !isolate) return command(...args);
    const nativeSelection = window.getSelection();
    try {
        for (const { id, root, range } of ranges) {
            nativeSelection.removeAllRanges();
            nativeSelection.addRange(range);
            state.dirty.add(id);
            if (isolate) writingIsolatedCommand(root, range, command, args);
            else command(...args);
        }
    } finally {
        window.NovalistEditorState.editor.focus({ preventScroll: true });
        window.restoreWritingSelection(selection);
    }
    window.NovalistEditorState.editor.dispatchEvent(new Event('input'));
}

for (const name of ['toggleBold', 'toggleItalic', 'toggleUnderline', 'toggleStrikethrough',
    'toggleHighlight', 'applyLink', 'alignLeft', 'alignCenter', 'alignRight', 'alignJustify',
    'setParagraphStyle', 'toggleBulletList', 'toggleNumberList']) {
    const command = window[name];
    if (command) window[name] = (...args) => writingFormatCommand(command, args,
        name === 'toggleBulletList' || name === 'toggleNumberList');
}
