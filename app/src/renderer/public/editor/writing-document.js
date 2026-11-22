'use strict';

const writingDocument = {
    enabled: false, context: null, origin: '', scenes: new Map(), order: [], dirty: new Set(),
    pending: [], beforeSelection: null, deferred: null, observer: null, updating: false,
    visible: new Set(), visibilityObserver: null
};
window.NovalistWritingDocument = writingDocument;

function setWritingContext(context, origin) {
    if (writingDocument.context && JSON.stringify(writingDocument.context) !== JSON.stringify(context)) {
        throw new Error('Writing context requires a new pane runtime');
    }
    writingDocument.context = { ...context };
    writingDocument.origin = origin;
}

function getWritingSceneRoot(sceneId) {
    const id = sceneId ?? window.getWritingSelection()?.focus.sceneId ?? writingDocument.activeId ?? writingDocument.order[0];
    return writingDocument.scenes.get(id)?.root || null;
}

function getWritingServiceRoot() {
    return writingDocument.enabled ? getWritingSceneRoot() || window.NovalistEditorState.editor : window.NovalistEditorState.editor;
}

function setWritingServiceScene(sceneId) {
    if (writingDocument.activeId === sceneId) return;
    writingDocument.activeId = sceneId;
    window.NovalistEditorState.commentGutterEl?.replaceChildren();
    window.NovalistEditorState.lastReadabilityGrading = null;
    window.clearReadability();
    window.setSceneContext(sceneId);
    window.requestReadability(0);
    window.scheduleCommentRender();
}

function collectWritingMutations(records) {
    if (writingDocument.updating) return;
    for (const record of records) {
        const root = window.writingSceneOf(record.target);
        if (root) writingDocument.dirty.add(root.dataset.writingScene);
    }
}

function serializeWritingScene(sceneId) {
    const entry = writingDocument.scenes.get(sceneId);
    if (!entry) throw new Error('Unknown writing scene');
    collectWritingMutations(writingDocument.observer?.takeRecords() || []);
    if (!writingDocument.dirty.has(sceneId)) return entry.snapshot.html;
    window.refreshSceneBreakClasses?.(entry.root);
    const html = window.cleanContentRoot(entry.root);
    return html === entry.normalized ? entry.snapshot.html : html;
}

function updateWritingScene(snapshot) {
    const entry = writingDocument.scenes.get(snapshot.sceneId);
    if (!entry) return;
    if (window.NovalistEditorState.isComposing && window.getWritingSelection()?.focus.sceneId === snapshot.sceneId) {
        writingDocument.remote ||= new Map();
        writingDocument.remote.set(snapshot.sceneId, snapshot);
        return;
    }
    const selection = window.getWritingSelection();
    if (entry.snapshot.html !== snapshot.html) {
        const updating = writingDocument.updating;
        writingDocument.updating = true;
        try {
            entry.root.replaceChildren(window.sceneContentFragment(snapshot.html || '<p><br></p>'));
            window.refreshSceneBreakClasses?.(entry.root);
            entry.normalized = window.cleanContentRoot(entry.root);
            window.toDisplayImages(entry.root);
            window.restoreWritingSelection(selection);
            writingDocument.projectedSelection = window.getWritingSelection();
        } finally { writingDocument.updating = updating; }
    }
    entry.snapshot = { ...snapshot };
}

function acknowledgeWritingScene(snapshot) {
    const entry = writingDocument.scenes.get(snapshot.sceneId);
    if (!entry) return;
    if (snapshot.revision >= entry.pendingProseRevision) delete entry.pendingProseRevision;
    if (snapshot.revision < entry.snapshot.revision ||
        (snapshot.revision === entry.snapshot.revision && snapshot.html === entry.snapshot.html)) return;
    entry.snapshot = { ...snapshot };
    entry.normalized = window.cleanContentRoot(entry.root);
}

function canRenderWritingScene(sceneId, revision) {
    const pending = writingDocument.scenes.get(sceneId)?.pendingProseRevision;
    return pending === undefined || revision >= pending;
}

function writingServiceState() {
    const selection = window.getWritingSelection();
    const activeSceneId = selection?.focus.sceneId ?? null;
    const selectedSceneIds = window.writingSelectedRanges().map(range => range.id);
    const visibleSceneIds = [...writingDocument.visible];
    return { activeSceneId, selectedSceneIds, visibleSceneIds,
        composingSceneId: window.NovalistEditorState.isComposing ? activeSceneId : null };
}

function observeWritingScene(root) {
    if (typeof IntersectionObserver === 'undefined') return;
    writingDocument.visibilityObserver ||= new IntersectionObserver(entries => {
        for (const entry of entries) {
            const id = entry.target.dataset.writingScene;
            if (entry.isIntersecting) {
                writingDocument.visible.add(id);
                window.repaginatePageView(entry.target);
            }
            else writingDocument.visible.delete(id);
        }
        window.sendMessage({ type: 'writingServicesChanged' });
    }, { root: window.NovalistEditorState.wrapper, rootMargin: '100% 0px' });
    writingDocument.visibilityObserver.observe(root);
}

function setWritingProjection(scenes, selection) {
    if (window.NovalistEditorState.isComposing || window.NovalistEditorState.compositionEndTimer) {
        writingDocument.deferred = { scenes, selection };
        return;
    }
    if (writingDocument.enabled) window.queueWritingChanges();
    const current = window.getWritingSelection();
    const retained = selection || writingDocument.selection || current;
    writingDocument.selection = retained;
    writingDocument.updating = true;
    writingDocument.observer?.disconnect();
    const editor = window.NovalistEditorState.editor;
    if (!writingDocument.enabled) editor.replaceChildren();
    writingDocument.enabled = true;
    writingDocument.order = scenes.map(scene => scene.sceneId);
    const visible = new Set(writingDocument.order);
    for (const [id, entry] of writingDocument.scenes) if (!visible.has(id)) {
        writingDocument.visibilityObserver?.unobserve(entry.root);
        writingDocument.visible.delete(id);
        entry.root.remove();
    }
    let previous = null;
    for (const incoming of scenes) {
        const retainedEntry = writingDocument.scenes.get(incoming.sceneId);
        const snapshot = retainedEntry && incoming.revision < retainedEntry.snapshot.revision ? retainedEntry.snapshot : incoming;
        let entry = writingDocument.scenes.get(snapshot.sceneId);
        if (!entry) {
            const root = document.createElement('section');
            root.dataset.writingScene = snapshot.sceneId;
            root.className = 'writing-scene';
            entry = { root, snapshot, normalized: '' };
            writingDocument.scenes.set(snapshot.sceneId, entry);
        }
        if (entry.snapshot.html !== snapshot.html || !entry.normalized) {
            entry.root.replaceChildren(window.sceneContentFragment(snapshot.html || '<p><br></p>'));
            window.refreshSceneBreakClasses?.(entry.root);
            entry.normalized = window.cleanContentRoot(entry.root);
            window.toDisplayImages(entry.root);
        }
        entry.snapshot = { ...snapshot };
        let next = previous ? previous.nextSibling : editor.firstChild;
        while (next?.nodeType === 1 && next.hasAttribute('data-editor-chrome')) next = next.nextSibling;
        if (next !== entry.root) editor.insertBefore(entry.root, next);
        previous = entry.root;
        observeWritingScene(entry.root);
    }
    writingDocument.observer ||= new MutationObserver(collectWritingMutations);
    writingDocument.observer.observe(editor, { childList: true, characterData: true, attributes: true, subtree: true });
    window.restoreWritingSelection(retained);
    writingDocument.projectedSelection = window.getWritingSelection();
    writingDocument.updating = false;
    window.sendMessage({ type: 'writingProjectionApplied' });
}

function flushWritingProjection() {
    if (writingDocument.remote?.size) {
        window.queueWritingChanges();
        for (const snapshot of writingDocument.remote.values()) updateWritingScene(snapshot);
        writingDocument.remote.clear();
    }
    const deferred = writingDocument.deferred;
    if (!deferred) return;
    writingDocument.deferred = null;
    window.queueWritingChanges();
    setWritingProjection(deferred.scenes, deferred.selection);
}

Object.assign(window, { setWritingContext, setWritingProjection, getWritingSceneRoot,
    serializeWritingScene, collectWritingMutations, flushWritingProjection, updateWritingScene, writingServiceState,
    getWritingServiceRoot, setWritingServiceScene, acknowledgeWritingScene, canRenderWritingScene });
