'use strict';

function inlineActionById(id) {
    for (const action of window.NovalistEditorState.inlineActions || []) {
        if (action.id === id) return action;
    }
    return null;
}

function precedingTextBefore(range) {
    try {
        const scope = document.createRange();
        const root = window.NovalistWritingDocument?.enabled ? window.writingSceneOf(range.startContainer) : window.NovalistEditorState.editor;
        if (!root) return '';
        scope.selectNodeContents(root);
        scope.setEnd(range.startContainer, range.startOffset);
        const text = scope.toString();
        return text.length > window.NovalistEditorState.PRECEDING_TEXT_LIMIT ? text.slice(-window.NovalistEditorState.PRECEDING_TEXT_LIMIT) : text;
    } catch {
        return '';
    }
}

let inlineRequestId = 0;

function triggerInlineAction(id, directive) {
    const action = inlineActionById(id);
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;

    const collapsed = sel.isCollapsed;
    // An action written before empty selections were a thing still needs one:
    // it would receive an empty SelectedText it was never written to handle.
    if (collapsed && !(action && action.allowsEmptySelection)) return;

    const range = sel.getRangeAt(0).cloneRange();
    const writing = window.NovalistWritingDocument?.enabled;
    const slices = writing ? window.writingSelectedRanges() : [];
    if (writing && !slices.length) return;
    const text = collapsed ? '' : writing ? slices.map(({ range }) => {
        const holder = document.createElement('div');
        holder.appendChild(range.cloneContents());
        return window.writingSceneText(holder).replace(/\n$/, '');
    }).join('\n') : sel.toString();
    if (!collapsed && !text) return;

    const requestId = ++inlineRequestId;
    const endpoints = writing ? [range.startContainer, range.endContainer].map(node => ({ node, root: window.writingSceneOf(node) })) : null;
    window.NovalistEditorState.pendingInlineAction = { id: id, range: range, requestId, originalText: range.toString(), endpoints };
    window.sendMessage({
        type: 'inlineActionRequested',
        actionId: id,
        requestId,
        selectedText: text,
        precedingText: precedingTextBefore(range),
        directive: directive || ''
    });
}

Object.assign(window, {
    inlineActionById,
    precedingTextBefore,
    triggerInlineAction
});
