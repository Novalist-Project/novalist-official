'use strict';

let writingDrag = null;

function writingDropReference(root) {
    const { bookId, draftId, chapterGuid, sceneId } = window.NovalistWritingDocument.scenes.get(root.dataset.writingScene).snapshot;
    return { bookId, draftId, chapterGuid, sceneId };
}

function remapWritingDragMarkers(fragment, source) {
    const transfers = [];
    const from = writingDropReference(source);
    const snapshot = window.NovalistWritingDocument.scenes.get(from.sceneId).snapshot;
    for (const [kind, attribute] of [['comment', 'data-comment-id'], ['footnote', 'data-fn-id']]) {
        const ids = new Map();
        for (const marker of fragment.querySelectorAll(`[${attribute}]`)) {
            const sourceId = marker.getAttribute(attribute);
            if (!ids.has(sourceId)) {
                const targetId = crypto.randomUUID();
                ids.set(sourceId, targetId);
                transfers.push({ from, kind, sourceId, targetId,
                    expectedSourceRevision: snapshot.revision, sourceHtml: snapshot.html });
            }
            marker.setAttribute(attribute, ids.get(sourceId));
        }
    }
    return transfers;
}

function writingDragStart(event) {
    if (!window.NovalistWritingDocument?.enabled || !event.dataTransfer) return;
    const ranges = window.writingSelectedRanges();
    if (!ranges.length || window.getSelection().isCollapsed) return;
    window.queueWritingChanges();
    const annotationTransfers = [];
    const fragments = ranges.map(({ root: source, range }) => {
        const root = window.writingSelectedContent(source, range);
        annotationTransfers.push(...remapWritingDragMarkers(root, source));
        return root;
    });
    const token = crypto.randomUUID();
    writingDrag = { token, annotationTransfers, selection: window.getWritingSelection(), ranges: ranges.map(({ root, range }) =>
        ({ root, range: range.cloneRange(), text: range.toString() })) };
    event.dataTransfer.setData('application/x-novalist-writing-drag', token);
    event.dataTransfer.setData('text/html', fragments.map(root => window.cleanContentRoot(root)).join(''));
    event.dataTransfer.setData('text/plain', fragments.map(root => window.writingSceneText(root).replace(/\n$/, '')).join('\n'));
    event.dataTransfer.effectAllowed = 'copyMove';
}

function writingDropTarget(event) {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (target?.closest('[data-editor-chrome]')) return null;
    const range = document.caretRangeFromPoint(event.clientX, event.clientY);
    return range && window.writingSceneOf(range.startContainer) ? range : null;
}

function insertWritingDropHtml(html, target) {
    const fragment = window.sanitizeSceneFragment(html);
    fragment.querySelectorAll('[data-writing-scene]').forEach(node => node.removeAttribute('data-writing-scene'));
    fragment.querySelectorAll('[data-editor-chrome]').forEach(node => node.remove());
    let last = fragment.lastChild;
    if (!last) return;
    const root = window.writingSceneOf(target.startContainer);
    const blockTags = 'p,div,section,article,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,table,pre';
    const hasBlocks = Array.from(fragment.children).some(node => node.matches(blockTags));
    let block = target.startContainer.nodeType === Node.TEXT_NODE ? target.startContainer.parentElement : target.startContainer;
    while (block && block !== root && block.parentElement !== root && !block.parentElement?.classList.contains('nv-page')) block = block.parentElement;
    if (hasBlocks && block && block !== root) {
        const tail = document.createRange();
        tail.selectNodeContents(block);
        tail.setStart(target.startContainer, target.startOffset);
        const after = block.cloneNode(false);
        after.appendChild(tail.extractContents());
        const next = block.nextSibling;
        block.parentNode.insertBefore(fragment, next);
        if (after.hasChildNodes()) block.parentNode.insertBefore(after, next);
        if (!block.textContent && !block.querySelector('br,img,hr,table,sup')) block.remove();
    } else target.insertNode(fragment);
    while (last.lastChild) last = last.lastChild;
    const annotation = last.parentElement?.closest('sup.nv-fn, [contenteditable="false"]');
    if (annotation && root.contains(annotation)) target.setStartAfter(annotation);
    else if (last.nodeType === Node.TEXT_NODE) target.setStart(last, last.length);
    else target.setStartAfter(last);
    target.collapse(true);
    window.ensureWritingCaret(target);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(target);
}

function writingDrop(event) {
    if (!window.NovalistWritingDocument?.enabled) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.dataTransfer || window.NovalistEditorState.isComposing) return;
    const target = writingDropTarget(event);
    if (!target) return;
    const destination = window.writingSceneOf(target.startContainer);
    const html = event.dataTransfer.getData('text/html');
    const text = event.dataTransfer.getData('text/plain');
    if (!html && !text) return;
    const drag = writingDrag?.token === event.dataTransfer.getData('application/x-novalist-writing-drag') ? writingDrag : null;
    const copy = event.dataTransfer.dropEffect === 'copy' || event.ctrlKey || event.altKey;
    if (drag && !copy) {
        if (drag.ranges.some(({ root, range, text: original }) => !root.isConnected ||
            !root.contains(range.startContainer) || !root.contains(range.endContainer) || range.toString() !== original)) return;
        if (drag.ranges.some(({ range }) => range.comparePoint(target.startContainer, target.startOffset) === 0)) return;
    }
    const selection = window.getSelection();
    window.NovalistWritingDocument.beforeSelection ||= drag?.selection || window.getWritingSelection();
    if (drag && !copy) {
        const source = document.createRange();
        const first = drag.ranges[0].range;
        const last = drag.ranges.at(-1).range;
        source.setStart(first.startContainer, first.startOffset);
        source.setEnd(last.endContainer, last.endOffset);
        selection.removeAllRanges();
        selection.addRange(source);
        if (window.NovalistEditorState.suggestionMode) window.markSelectionDeleted();
        else if (!window.deleteWritingSelection()) selection.getRangeAt(0).deleteContents();
    }
    window.NovalistEditorState.editor.focus({ preventScroll: true });
    selection.removeAllRanges();
    selection.addRange(target);
    if (window.NovalistEditorState.suggestionMode) window.insertSuggested(text);
    else if (html) insertWritingDropHtml(html, target);
    else document.execCommand('insertText', false, text);
    if (drag?.annotationTransfers.length && !window.NovalistEditorState.suggestionMode) {
        const state = window.NovalistWritingDocument;
        state.annotationTransfers ||= [];
        state.annotationTransfers.push(...drag.annotationTransfers.map(transfer => ({ ...transfer,
            to: writingDropReference(destination), move: !copy })));
        for (const root of new Set([destination, ...drag.ranges.map(source => source.root)])) {
            root.querySelectorAll('sup.nv-fn').forEach((marker, index) => { marker.textContent = String(index + 1); });
        }
    }
    window.NovalistEditorState.editor.dispatchEvent(new Event('input', { bubbles: true }));
    writingDrag = null;
}

window.NovalistEditorState.editor.addEventListener('dragstart', writingDragStart);
window.NovalistEditorState.editor.addEventListener('dragover', event => {
    if (window.NovalistWritingDocument?.enabled) event.preventDefault();
});
window.NovalistEditorState.editor.addEventListener('drop', writingDrop);
window.NovalistEditorState.editor.addEventListener('dragend', () => { writingDrag = null; });
