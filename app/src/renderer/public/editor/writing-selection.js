'use strict';

let writingTextMapping = null;

function configureWritingTextMapping(mapping) {
    writingTextMapping = mapping;
}

function writingSceneOf(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return element?.closest('[data-writing-scene]') || null;
}

// Match HtmlSearchText: UTF-16 text plus a newline for BR and closing P.
function writingTextParts(root) {
    if (writingTextMapping) return writingTextMapping.parts(root);
    const parts = [];
    let offset = 0;
    function visit(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            parts.push({ node, start: offset, text: node.data });
            offset += node.data.length;
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE || node.hasAttribute('data-editor-chrome')) return;
        for (const child of node.childNodes) visit(child);
        if (node.nodeName === 'BR' || node.nodeName === 'P') {
            parts.push({ node, start: offset, text: '\n' });
            offset++;
        }
    }
    for (const child of root.childNodes) visit(child);
    return parts;
}

function writingSceneText(root) {
    return writingTextParts(root).map(part => part.text).join('');
}

function writingDomPoint(point) {
    const root = window.getWritingSceneRoot(point.sceneId);
    if (!root) return null;
    if (writingTextMapping) return writingTextMapping.domPoint(root, point.offset, point.affinity);
    const parts = writingTextParts(root);
    for (const part of parts) {
        if (point.offset > part.start + part.text.length) continue;
        if (part.node.nodeType === Node.TEXT_NODE) {
            return { node: part.node, offset: Math.max(0, point.offset - part.start) };
        }
        if (point.offset <= part.start && part.node.nodeName === 'P') {
            return { node: part.node, offset: part.node.childNodes.length };
        }
        const parent = part.node.parentNode;
        return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, part.node) + (point.offset > part.start ? 1 : 0) };
    }
    return { node: root, offset: root.childNodes.length };
}

function writingPointFromDom(node, offset, affinity = 'after') {
    const root = writingSceneOf(node);
    if (!root) {
        if (node !== window.NovalistEditorState.editor) return null;
        const after = Array.from(node.childNodes).slice(offset).find(child => child.dataset?.writingScene);
        if (after) return { sceneId: after.dataset.writingScene, offset: 0, affinity };
        const before = Array.from(node.childNodes).slice(0, offset).reverse().find(child => child.dataset?.writingScene);
        return before ? { sceneId: before.dataset.writingScene, offset: writingSceneText(before).length, affinity } : null;
    }
    if (writingTextMapping) return { sceneId: root.dataset.writingScene,
        offset: writingTextMapping.offset(root, node, offset), affinity };
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    const fragment = document.createElement('div');
    fragment.appendChild(range.cloneContents());
    let length = writingSceneText(fragment).length;
    // A partial paragraph clone has an artificial closing P.
    const parent = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (parent.closest('p') && parent !== root) length--;
    return { sceneId: root.dataset.writingScene, offset: Math.max(0, length), affinity };
}

function getWritingSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const anchor = writingPointFromDom(selection.anchorNode, selection.anchorOffset);
    const focus = writingPointFromDom(selection.focusNode, selection.focusOffset);
    if (!anchor || !focus) return null;
    const result = { anchor, focus };
    const state = window.NovalistWritingDocument;
    if (state && !state.updating && !state.chromeSelection && JSON.stringify(result) !== JSON.stringify(state.projectedSelection)) {
        state.selection = result;
        state.projectedSelection = null;
    }
    return result;
}

function restoreWritingSelection(selection) {
    if (!selection) return;
    const state = window.NovalistWritingDocument;
    if (state && !state.updating) {
        state.chromeSelection = false;
        state.selection = selection;
        state.projectedSelection = null;
    }
    const anchor = writingDomPoint(selection.anchor);
    const focus = writingDomPoint(selection.focus);
    if (!anchor || !focus || !anchor.node.isConnected || !focus.node.isConnected) return;
    window.getSelection().setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}

let stopWritingReveal = null;

function cancelWritingReveal() {
    stopWritingReveal?.();
    stopWritingReveal = null;
}

function revealWritingPoint(point, viewportOffset) {
    cancelWritingReveal();
    const root = window.getWritingSceneRoot(point.sceneId);
    if (!root) return;
    const visibility = root.style.contentVisibility;
    root.style.contentVisibility = 'visible';
    window.repaginatePageView?.(root);
    restoreWritingSelection({ anchor: point, focus: point });
    const viewport = window.NovalistEditorState.wrapper;
    const align = () => {
        if (!root.isConnected) { cancelWritingReveal(); return; }
        const position = writingDomPoint(point);
        const element = position?.node.nodeType === Node.ELEMENT_NODE ? position.node : position?.node.parentElement;
        if (position && Number.isFinite(viewportOffset)) {
            const range = document.createRange();
            range.setStart(position.node, position.offset);
            range.collapse(true);
            const caret = range.getBoundingClientRect();
            const top = caret.height ? caret.top : element.getBoundingClientRect().top;
            viewport.scrollTop += top - viewport.getBoundingClientRect().top - viewportOffset;
        } else element?.scrollIntoView({ block: point.offset === 0 ? 'start' : 'center' });
        window.NovalistEditorState.savedScrollTop = viewport.scrollTop;
    };
    align();
    root.style.contentVisibility = visibility;
    window.NovalistEditorState.cancelFocusScrollRestore?.();
    if (typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const schedule = () => {
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; align(); });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(window.NovalistEditorState.editor);
    observer.observe(root);
    // Late scroll restoration can move the target without resizing it.
    viewport.addEventListener('scroll', schedule, { passive: true });
    stopWritingReveal = () => {
        observer.disconnect();
        viewport.removeEventListener('scroll', schedule);
        cancelAnimationFrame(frame);
    };
}

function captureWritingSplit(point) {
    const root = window.getWritingSceneRoot(point.sceneId);
    const caret = writingDomPoint(point);
    if (!root || !caret || !root.contains(caret.node)) throw new Error('The scene split position is unavailable');
    if (window.NovalistEditorState.isComposing) throw new Error('Finish composing before splitting the scene');
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(caret.node, caret.offset);
    const after = document.createRange();
    after.selectNodeContents(root);
    after.setStart(caret.node, caret.offset);
    const clean = range => {
        const holder = document.createElement('div');
        holder.appendChild(range.cloneContents());
        if (!holder.textContent && !holder.querySelector('img,hr,br,table,sup')) return '<p><br></p>';
        return window.cleanContentRoot(holder);
    };
    return { sourceHtml: window.serializeWritingScene(point.sceneId), beforeHtml: clean(before), afterHtml: clean(after) };
}

Object.assign(window, { writingSceneOf, writingTextParts, writingSceneText, writingDomPoint,
    writingPointFromDom, getWritingSelection, restoreWritingSelection, revealWritingPoint, cancelWritingReveal, configureWritingTextMapping, captureWritingSplit });

function replaceWritingBookmark(event) {
    const state = window.NovalistWritingDocument;
    if (!state?.enabled || state.updating) return;
    state.chromeSelection = !!event.target.closest?.('[data-editor-chrome]');
    if (state.chromeSelection) return;
    state.projectedSelection = null;
    state.selection = getWritingSelection();
}

const bookmarkRoot = window.NovalistEditorState.editor;
for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'beforeinput', 'compositionstart']) {
    document.addEventListener(event, cancelWritingReveal, { capture: true, passive: true });
}
for (const event of ['pointerdown', 'beforeinput', 'compositionstart', 'cut', 'paste']) {
    bookmarkRoot.addEventListener(event, replaceWritingBookmark, true);
}
bookmarkRoot.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key) ||
        ((event.ctrlKey || event.metaKey) && window.NovalistShortcutKeys.key(event) === 'a')) replaceWritingBookmark(event);
}, true);
