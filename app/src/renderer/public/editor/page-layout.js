'use strict';

const pendingPageRoots = new Set();
let pendingPageLayout = false;

function setMobile(enabled) {
    // Full-width text (drop the margin comment gutter) + touch-sized controls.
    document.body.classList.toggle('mobile', !!enabled);
}

function setPageView(enabled) {
    const wasEnabled = window.NovalistEditorState.pageViewEnabled;
    window.NovalistEditorState.pageViewEnabled = !!enabled;
    document.body.classList.toggle('page-view', window.NovalistEditorState.pageViewEnabled);
    if (window.NovalistEditorState.pageViewEnabled) {
        if (!window.NovalistEditorState.pageViewMutationObserver) {
            window.NovalistEditorState.pageViewMutationObserver = new MutationObserver(records => {
                if (window.NovalistEditorState.pageViewRepaginating) return;
                if (!window.NovalistWritingDocument?.enabled) { schedulePageViewRepaginate(); return; }
                for (const record of records) {
                    const root = window.writingSceneOf(record.target);
                    if (root) schedulePageViewRepaginate(root);
                }
            });
        }
        window.NovalistEditorState.pageViewMutationObserver.observe(window.NovalistEditorState.editor, { childList: true, characterData: true, subtree: true });
        // Apply the paper and its padding together. Deferring the first wrap
        // leaves already-visible prose jumping when the debounce later fires.
        // Further edits/settings keep their debounce; active composition is
        // still protected by repaginatePageView's composition guard.
        if (wasEnabled) schedulePageViewRepaginate();
        else repaginatePageView();
    } else {
        if (window.NovalistEditorState.pageViewMutationObserver) {
            window.NovalistEditorState.pageViewMutationObserver.disconnect();
        }
        const savedDictation = window.captureDictationPosition();
        unwrapPages();
        window.restoreDictationPosition(savedDictation);
    }
}

function schedulePageViewRepaginate(root) {
    if (!window.NovalistEditorState.pageViewEnabled || window.NovalistEditorState.isComposing) return;
    if (root && root !== window.NovalistEditorState.editor) pendingPageRoots.add(root);
    else pendingPageLayout = true;
    if (window.NovalistEditorState.pageViewRepaginateScheduled) return;
    window.NovalistEditorState.pageViewRepaginateScheduled = true;
    setTimeout(() => {
        window.NovalistEditorState.pageViewRepaginateScheduled = false;
        const roots = [...pendingPageRoots];
        const all = pendingPageLayout;
        pendingPageRoots.clear();
        pendingPageLayout = false;
        if (all) { repaginatePageView(); return; }
        const state = window.NovalistWritingDocument?.enabled ? window.writingServiceState() : null;
        const visible = state && new Set([...state.visibleSceneIds, ...state.selectedSceneIds, state.activeSceneId]);
        for (const scene of roots) {
            if (scene.isConnected && (!visible || visible.has(scene.dataset.writingScene))) repaginatePageView(scene);
        }
    }, 150);
}

function captureSelectionForRepaginate(root) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0);
    if (!window.NovalistEditorState.editor.contains(r.startContainer)) return null;
    if (!root.contains(sel.anchorNode) && !root.contains(sel.focusNode)) return null;
    // Snapshot the live (node, offset) pair. Unwrap/rewrap of .nv-page wrappers
    // only moves these nodes around; the references stay valid, so restoring
    // them preserves the caret exactly — including in empty paragraphs that a
    // text-only walker would skip past.
    return {
        anchorNode: sel.anchorNode,
        anchorOffset: sel.anchorOffset,
        focusNode: sel.focusNode,
        focusOffset: sel.focusOffset,
        startContainer: r.startContainer,
        startOffset: r.startOffset,
        endContainer: r.endContainer,
        endOffset: r.endOffset,
    };
}

function restoreSelectionForRepaginate(saved) {
    if (!saved) return;
    if (!window.NovalistEditorState.editor.contains(saved.startContainer) || !window.NovalistEditorState.editor.contains(saved.endContainer)) return;
    const r = document.createRange();
    try {
        r.setStart(saved.startContainer, saved.startOffset);
        r.setEnd(saved.endContainer, saved.endOffset);
    } catch {
        return;
    }
    const sel = window.getSelection();
    if (saved.anchorNode && saved.focusNode) {
        sel.setBaseAndExtent(saved.anchorNode, saved.anchorOffset, saved.focusNode, saved.focusOffset);
        return;
    }
    sel.removeAllRanges();
    sel.addRange(r);
}

function unwrapPages(root = window.NovalistEditorState.editor) {
    const pages = Array.from(root.querySelectorAll('.nv-page'));
    if (pages.length === 0) return;
    pages.forEach(page => {
        while (page.firstChild) page.parentNode.insertBefore(page.firstChild, page);
        page.remove();
    });
}

function groupPageBlocks(children, heights, pageContentHeight) {
    const groups = [];
    let current = [], currentHeight = 0;
    for (let i = 0; i < children.length; i++) {
        if (currentHeight + heights[i] > pageContentHeight && current.length > 0) {
            groups.push(current);
            current = [];
            currentHeight = 0;
        }
        current.push(children[i]);
        currentHeight += heights[i];
    }
    if (current.length > 0) groups.push(current);
    return groups;
}

function reconcilePageGroups(root, pages, groups, measuringPage) {
    let changed = !!measuringPage;
    groups.forEach((group, index) => {
        let page = pages[index];
        if (!page) {
            page = document.createElement('div');
            page.className = 'nv-page';
            root.insertBefore(page, measuringPage);
            changed = true;
        }
        let next = page.firstChild;
        for (const node of group) {
            if (node === next) next = next.nextSibling;
            else { page.insertBefore(node, next); changed = true; }
        }
    });
    for (const page of pages.slice(groups.length)) { page.remove(); changed = true; }
    measuringPage?.remove();
    return changed;
}

function repaginatePageView(root = window.NovalistEditorState.editor) {
    if (!window.NovalistEditorState.pageViewEnabled || window.NovalistEditorState.isComposing) return;
    if (window.NovalistWritingDocument?.enabled && root === window.NovalistEditorState.editor) {
        const state = window.writingServiceState();
        const ids = new Set([...state.visibleSceneIds, ...state.selectedSceneIds, state.activeSceneId]);
        for (const id of ids) {
            const sceneRoot = id && window.getWritingSceneRoot(id);
            if (sceneRoot) repaginatePageView(sceneRoot);
        }
        return;
    }
    window.NovalistEditorState.pageViewRepaginating = true;
    if (window.NovalistEditorState.pageViewMutationObserver) window.NovalistEditorState.pageViewMutationObserver.disconnect();
    const savedDictation = window.captureDictationPosition();
    const savedScrollTop = window.NovalistEditorState.wrapper.scrollTop;
    let changed = false;
    try {
        const savedSelection = captureSelectionForRepaginate(root);
        for (const nested of root.querySelectorAll('.nv-page .nv-page')) {
            while (nested.firstChild) nested.parentNode.insertBefore(nested.firstChild, nested);
            nested.remove();
            changed = true;
        }
        const pages = Array.from(root.children).filter(node => node.classList.contains('nv-page'));
        const children = Array.from(root.childNodes).flatMap(node => pages.includes(node) ? Array.from(node.childNodes) : [node]);
        if (children.length === 0) {
            for (const page of pages) { page.remove(); changed = true; }
            return;
        }
        // Existing pages already provide the final text width. Only new loose
        // blocks need a measuring wrapper; unchanged prose stays in place.
        const loose = children.filter(node => node.parentNode === root);
        let measuringPage = null;
        if (loose.length) {
            measuringPage = document.createElement('div');
            measuringPage.className = 'nv-page';
            root.appendChild(measuringPage);
            for (const node of loose) measuringPage.appendChild(node);
            changed = true;
        }
        const style = getComputedStyle(window.NovalistEditorState.editor);
        const zoom = document.body.classList.contains('unified-writing-canvas') ? 1 : Number(style.getPropertyValue('--writing-zoom-scale')) || 1;
        const heights = children.map(node => {
            if (node.nodeType === Node.ELEMENT_NODE) return Math.max(1, node.offsetHeight);
            const range = document.createRange();
            range.selectNode(node);
            return Math.max(1, range.getBoundingClientRect().height / zoom);
        });
        const groups = groupPageBlocks(children, heights, 48 * (parseFloat(style.fontSize) || 16));
        changed = reconcilePageGroups(root, pages, groups, measuringPage) || changed;
        if (changed) restoreSelectionForRepaginate(savedSelection);
    } finally {
        if (changed) {
            window.restoreDictationPosition(savedDictation);
            window.NovalistEditorState.wrapper.scrollTop = savedScrollTop;
        }
        window.NovalistEditorState.pageViewRepaginating = false;
        if (window.NovalistEditorState.pageViewMutationObserver && window.NovalistEditorState.pageViewEnabled) {
            window.NovalistEditorState.pageViewMutationObserver.observe(window.NovalistEditorState.editor, { childList: true, characterData: true, subtree: true });
        }
        if (changed) {
            window.reapplyReadability();
            window.restoreWritingZoomCaret?.();
        }
    }
}

Object.assign(window, {
    setMobile,
    setPageView,
    schedulePageViewRepaginate,
    captureSelectionForRepaginate,
    restoreSelectionForRepaginate,
    unwrapPages,
    repaginatePageView
});
