'use strict';

function getProofingStatus() {
    const state = window.NovalistEditorState;
    return {
        enabled: state.grammarEnabled,
        checking: state.grammarChecking,
        grammarCount: state.grammarIssues.filter(i => i.type === 'grammar').length,
        spellingCount: state.grammarIssues.filter(i => i.type === 'spelling' || i.type === 'style').length
    };
}

function setProofingStatusHosted(enabled) {
    document.body.classList.toggle('proofing-status-hosted', !!enabled);
}

function updateGrammarStatusBar() {
    // The shell reads the live snapshot when this queued notification arrives,
    // so a result from a previous scene cannot restore stale status counts.
    window.sendMessage({ type: 'grammarStatusChanged' });
    if (!window.NovalistEditorState.grammarStatusBar) return;
    const status = getProofingStatus();
    window.logToHost("updateGrammarStatusBar: grammarEnabled=" + window.NovalistEditorState.grammarEnabled + ", grammarChecking=" + window.NovalistEditorState.grammarChecking + ", issues count=" + window.NovalistEditorState.grammarIssues.length);

    if (!status.enabled) {
        window.NovalistEditorState.grammarStatusBar.classList.remove('visible');
        return;
    }

    window.NovalistEditorState.grammarStatusBar.classList.add('visible');

    const throbber = document.getElementById('status-throbber');
    const doneIcon = document.getElementById('status-check-done');
    const grammarItem = document.getElementById('status-grammar-count-container');
    const punctuationItem = document.getElementById('status-punctuation-count-container');
    const grammarCountSpan = document.getElementById('status-grammar-count');
    const punctuationCountSpan = document.getElementById('status-punctuation-count');

    // Throbber state
    if (status.checking) {
        throbber.classList.add('active');
        doneIcon.classList.remove('active');
    } else {
        throbber.classList.remove('active');
    }

    // Compute counts
    const grammarCount = status.grammarCount;
    const punctuationCount = status.spellingCount;

    // Show checkmark done only when not checking and counts are 0
    if (!status.checking && grammarCount === 0 && punctuationCount === 0) {
        doneIcon.classList.add('active');
    } else {
        doneIcon.classList.remove('active');
    }

    if (grammarCount > 0) {
        grammarCountSpan.textContent = grammarCount;
        grammarItem.classList.add('active');
    } else {
        grammarItem.classList.remove('active');
    }

    if (punctuationCount > 0) {
        punctuationCountSpan.textContent = punctuationCount;
        punctuationItem.classList.add('active');
    } else {
        punctuationItem.classList.remove('active');
    }
}

let pendingProofingNavigation = null;

function cancelProofingNavigation() {
    if (!pendingProofingNavigation) return;
    const cancel = pendingProofingNavigation;
    pendingProofingNavigation = null;
    cancel();
}

function openProofingIssueAfterScroll(target) {
    const state = window.NovalistEditorState;
    const index = Number(target.dataset.issueIndex);
    const issue = state.grammarIssues[index];
    const wrapper = state.wrapper;
    const hasScrollEnd = 'onscrollend' in wrapper;
    const interruptions = ['wheel', 'pointerdown', 'touchstart', 'keydown'];
    let timer;

    function cancel() {
        clearTimeout(timer);
        wrapper.removeEventListener('scroll', onScroll);
        wrapper.removeEventListener('scrollend', finish);
        for (const event of interruptions) document.removeEventListener(event, cancelProofingNavigation, true);
    }

    function finish() {
        if (pendingProofingNavigation !== cancel) return;
        cancelProofingNavigation();
        if (!target.isConnected || !state.editor.contains(target)
            || state.grammarIssues[index] !== issue || Number(target.dataset.issueIndex) !== index) return;
        const rect = target.getBoundingClientRect();
        window.showGrammarPopup(index, rect.left, rect.bottom);
    }

    function onScroll() {
        clearTimeout(timer);
        if (!hasScrollEnd) timer = setTimeout(finish, 150);
    }

    pendingProofingNavigation = cancel;
    wrapper.addEventListener('scroll', onScroll);
    if (hasScrollEnd) wrapper.addEventListener('scrollend', finish);
    for (const event of interruptions) document.addEventListener(event, cancelProofingNavigation, true);
    // An already visible target produces no scrollend event.
    timer = setTimeout(finish, 150);
    window.cancelWritingReveal?.();
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function scrollToNextIssue(type) {
    window.hideGrammarPopup();
    const selector = type === 'grammar'
        ? '.grammar-issue[data-issue-type="grammar"]'
        : '.grammar-issue[data-issue-type="spelling"], .grammar-issue[data-issue-type="style"]';
    const firstIssue = window.NovalistEditorState.editor.querySelector(selector);
    if (firstIssue) openProofingIssueAfterScroll(firstIssue);
}

function updateFloatingToolbar(allowCaret = false) {
    const toolbar = window.NovalistEditorState.floatingToolbar;
    if (toolbar.contains(document.activeElement)) return;
    // Right-clicking a word selects it so the menu can offer spellings for it,
    // and that selection used to raise the format bar on top of the very menu
    // the click had just opened - the bar sits a layer above it. The menu is
    // what was asked for, so the bar waits until it closes.
    if (window.NovalistEditorState.contextMenu.classList.contains('visible')) {
        window.NovalistEditorState.floatingToolbar.classList.remove('visible');
        return;
    }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !window.captureQuickEditSelection()
        || window.NovalistEditorState.quickEditDismissed
        || (!allowCaret && (sel.isCollapsed || sel.toString().trim() === ''))) {
        window.NovalistEditorState.floatingToolbar.classList.remove('visible');
        return;
    }
    const range = sel.getRangeAt(0);
    let rect = range.getBoundingClientRect();
    if (allowCaret && rect.width === 0 && rect.height === 0) {
        const block = window.blockOf(range.startContainer);
        if (block) rect = block.getBoundingClientRect();
    }
    if (rect.width === 0 && rect.height === 0) {
        window.NovalistEditorState.floatingToolbar.classList.remove('visible');
        return;
    }

    document.getElementById('ft-bold').classList.toggle('active', document.queryCommandState('bold'));
    document.getElementById('ft-italic').classList.toggle('active', document.queryCommandState('italic'));
    document.getElementById('ft-underline').classList.toggle('active', document.queryCommandState('underline'));
    document.getElementById('ft-strike').classList.toggle('active', document.queryCommandState('strikeThrough'));
    document.getElementById('ft-highlight').classList.toggle('active',
        !!window.highlightAncestor(window.getSelection() && window.getSelection().anchorNode));
    document.getElementById('ft-style').value = window.getParagraphStyle();

    window.NovalistEditorState.floatingToolbar.classList.add('visible');
    const tbWidth = window.NovalistEditorState.floatingToolbar.offsetWidth || 220;
    const tbHeight = window.NovalistEditorState.floatingToolbar.offsetHeight || 34;
    let x = rect.left + rect.width / 2 - tbWidth / 2;
    let y = rect.top - tbHeight - 8;
    if (y < 4) y = rect.bottom + 8;
    x = Math.max(4, Math.min(x, window.innerWidth - tbWidth - 4));
    y = Math.max(4, Math.min(y, window.innerHeight - tbHeight - 4));
    window.NovalistEditorState.floatingToolbar.style.left = x + 'px';
    window.NovalistEditorState.floatingToolbar.style.top = y + 'px';
}

Object.assign(window, {
    getProofingStatus,
    setProofingStatusHosted,
    updateGrammarStatusBar,
    cancelProofingNavigation,
    scrollToNextIssue,
    updateFloatingToolbar
});
