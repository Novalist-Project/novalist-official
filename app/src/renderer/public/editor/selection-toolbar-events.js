'use strict';

// ── Floating Selection Toolbar ───────────────────────────────────

const floatingToolbar = document.getElementById('floating-toolbar');

let floatingToolbarTimer = null;
let quickEditSelection = null;
let quickEditDismissed = false;

function captureQuickEditSelection() {
    const selection = window.getSelection();
    const editor = window.NovalistEditorState.editor;
    if (!selection || !selection.rangeCount || !editor.contains(selection.anchorNode)
        || !editor.contains(selection.focusNode)) return false;
    const next = {
        anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode, focusOffset: selection.focusOffset,
        range: selection.getRangeAt(0).cloneRange()
    };
    quickEditSelection = next;
    return true;
}

function restoreQuickEditSelection() {
    const saved = quickEditSelection;
    const editor = window.NovalistEditorState.editor;
    if (!saved || !editor.contains(saved.anchorNode) || !editor.contains(saved.focusNode)) return false;
    editor.focus({ preventScroll: true });
    window.getSelection().setBaseAndExtent(saved.anchorNode, saved.anchorOffset, saved.focusNode, saved.focusOffset);
    return true;
}

function openQuickEdit() {
    if (!captureQuickEditSelection()) return;
    quickEditDismissed = false;
    window.NovalistEditorState.contextMenu.classList.remove('visible');
    window.updateFloatingToolbar(true);
    document.getElementById('ft-style').focus({ preventScroll: true });
}

function closeQuickEdit() {
    restoreQuickEditSelection();
    quickEditDismissed = true;
    floatingToolbar.classList.remove('visible');
}

function setWritingStructureEnabled(enabled) {
    window.writingStructureEnabled = !!enabled;
    document.getElementById('ft-structure').hidden = !enabled;
}

function requestWritingStructure(command) {
    if (!window.writingStructureEnabled
        || !['sceneBreak', 'chapterHeading', 'insertChapter'].includes(command)) return;
    window.sendMessage({ type: 'writingStructureRequested', command });
}

document.addEventListener('selectionchange', () => {
    if (floatingToolbarTimer) clearTimeout(floatingToolbarTimer);
    floatingToolbarTimer = setTimeout(window.updateFloatingToolbar, 60);
});

floatingToolbar.addEventListener('mousedown', (e) => {
    captureQuickEditSelection();
    if (e.target.closest('button')) e.preventDefault();
});

floatingToolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !restoreQuickEditSelection()) return;
    const id = btn.id;
    if (id === 'ft-bold') document.execCommand('bold', false, null);
    else if (id === 'ft-italic') document.execCommand('italic', false, null);
    else if (id === 'ft-underline') document.execCommand('underline', false, null);
    else if (id === 'ft-strike') document.execCommand('strikeThrough', false, null);
    else if (id === 'ft-highlight') window.toggleHighlight();
    // The host owns dialogs, so it asks for the address and calls back.
    else if (id === 'ft-link') window.sendMessage({ type: 'requestLink' });
    else if (id === 'ft-comment') window.sendMessage({ type: 'requestAddComment' });
    else if (id === 'ft-footnote') window.sendMessage({ type: 'requestAddFootnote' });
    window.updateFloatingToolbar();
});

document.getElementById('ft-style').addEventListener('change', (e) => {
    if (!restoreQuickEditSelection()) return;
    window.setParagraphStyle(e.target.value);
    window.updateFloatingToolbar(true);
});

document.getElementById('ft-structure').addEventListener('change', (e) => {
    const command = e.target.value;
    e.target.value = '';
    if (restoreQuickEditSelection()) requestWritingStructure(command);
});

floatingToolbar.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeQuickEdit();
    }
});

document.addEventListener('pointerdown', (e) => {
    if (!floatingToolbar.contains(e.target)) {
        quickEditDismissed = false;
        floatingToolbar.classList.remove('visible');
    }
});

window.NovalistEditorState.editor.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') quickEditDismissed = false;
});

Object.assign(window, {
    captureQuickEditSelection, restoreQuickEditSelection, openQuickEdit,
    setWritingStructureEnabled, requestWritingStructure
});

Object.defineProperties(window.NovalistEditorState, {
    floatingToolbar: { get() { return floatingToolbar; } },
    quickEditDismissed: { get() { return quickEditDismissed; } }
});
