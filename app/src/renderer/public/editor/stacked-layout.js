'use strict';

// ── Stacked layout ──────────────────────────────────────────────
// The chapter and manuscript scopes put one editor per scene one below the
// other, and the host scrolls the stack rather than each frame scrolling its
// own scene. A stacked frame is as tall as its prose, so it tells the host its
// height whenever that changes.
//
// The popups drawn inside the frame - context menu, grammar card, mention
// picker, selection toolbar - count towards that height while they are open.
// A frame cut to the height of a two-line scene would otherwise clip a menu
// opened on its last line.

let stackedEnabled = false;

let stackedReported = 0;

let stackedFrame = 0;

const STACKED_POPUP_IDS = ['context-menu', 'grammar-popup', 'mention-picker', 'floating-toolbar'];

const STACKED_POPUP_MARGIN = 8;

function stackedPopupBottom() {
    let bottom = 0;
    STACKED_POPUP_IDS.forEach(function (id) {
        const element = document.getElementById(id);
        if (!element) return;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const rect = element.getBoundingClientRect();
        if (rect.height === 0) return;
        bottom = Math.max(bottom, rect.bottom + window.scrollY + STACKED_POPUP_MARGIN);
    });
    return bottom;
}

function measureStackedHeight() {
    stackedFrame = 0;
    if (!stackedEnabled) return;
    const wrapper = window.NovalistEditorState.wrapper;
    const height = Math.ceil(Math.max(wrapper.scrollHeight, stackedPopupBottom()));
    if (height === stackedReported) return;
    stackedReported = height;
    window.sendMessage({ type: 'contentHeight', height: height });
}

function scheduleStackedMeasure() {
    if (!stackedEnabled || stackedFrame) return;
    stackedFrame = requestAnimationFrame(measureStackedHeight);
}

const stackedResizeObserver = new ResizeObserver(scheduleStackedMeasure);

const stackedPopupObserver = new MutationObserver(scheduleStackedMeasure);

const originalSetTypewriterScroll = window.setTypewriterScroll;

/**
 * Typewriter scrolling recentres the caret inside the frame's own scroll box,
 * and a stacked frame has none - its padding is measured in viewport heights,
 * which for a frame sized to its content is a loop. Stacked frames keep it off
 * whatever the setting says.
 */
window.setTypewriterScroll = function (enabled, anchor) {
    originalSetTypewriterScroll(stackedEnabled ? false : enabled, anchor);
};

/** Switches the frame between filling its pane and sizing to its prose. */
window.setStacked = function (enabled) {
    const next = !!enabled;
    if (next === stackedEnabled) return;
    stackedEnabled = next;
    document.documentElement.classList.toggle('nv-stacked', stackedEnabled);
    if (stackedEnabled) {
        originalSetTypewriterScroll(false, window.NovalistEditorState.typewriterAnchor);
        stackedResizeObserver.observe(window.NovalistEditorState.editor);
        STACKED_POPUP_IDS.forEach(function (id) {
            const element = document.getElementById(id);
            if (element) stackedPopupObserver.observe(element, { attributes: true, childList: true, subtree: true });
        });
        stackedReported = 0;
        scheduleStackedMeasure();
    } else {
        stackedResizeObserver.disconnect();
        stackedPopupObserver.disconnect();
    }
};

// ── Moving between stacked scenes ───────────────────────────────
// Each scene in a stack is its own frame, so the arrow keys would stop dead at
// the last line of one scene. On the first or last line they hand the caret to
// the host, which puts it in the scene above or below.

function stackedCaretRect() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(false);
    const rect = range.getClientRects()[0];
    if (rect) return rect;
    const node = range.startContainer;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return element ? element.getBoundingClientRect() : null;
}

function stackedContentEdges() {
    const range = document.createRange();
    range.selectNodeContents(window.NovalistEditorState.editor);
    const rects = range.getClientRects();
    if (rects.length === 0) return null;
    return { top: rects[0].top, bottom: rects[rects.length - 1].bottom };
}

function stackedBoundary(direction) {
    const selection = window.getSelection();
    if (!selection || !selection.isCollapsed) return false;
    const edges = stackedContentEdges();
    if (!edges) return true;
    const caret = stackedCaretRect();
    if (!caret) return false;
    const line = parseFloat(getComputedStyle(window.NovalistEditorState.editor).lineHeight) || 20;
    return direction === 'next'
        ? caret.bottom > edges.bottom - line / 2
        : caret.top < edges.top + line / 2;
}

window.NovalistEditorState.editor.addEventListener('keydown', function (event) {
    if (!stackedEnabled || event.defaultPrevented) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    const direction = event.key === 'ArrowDown' ? 'next' : 'previous';
    if (!stackedBoundary(direction)) return;
    event.preventDefault();
    window.sendMessage({ type: 'stackBoundary', direction: direction });
});

/** Puts the caret at the start or the end of the scene, arriving from a neighbour. */
window.focusStackedEdge = function (edge) {
    const editor = window.NovalistEditorState.editor;
    editor.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(edge === 'start');
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
};
