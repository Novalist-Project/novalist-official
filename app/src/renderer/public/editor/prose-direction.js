'use strict';

function applyProseDirection(root) {
    const selector = 'p,div,h1,h2,h3,h4,h5,h6,blockquote,li,ul,ol,pre';
    const blocks = Array.from(root.querySelectorAll(selector));
    if (root.matches?.(selector)) blocks.unshift(root);
    for (const block of blocks) {
        if (block.id === 'editor' || block.closest('[data-editor-chrome]') ||
            block.matches('.nv-page,.writing-scene,.scene-editor,.nl-prose,[data-writing-scene]') ||
            block.tagName === 'DIV' && block.querySelector('p,div,h1,h2,h3,h4,h5,h6,blockquote,li,ul,ol,pre')) continue;
        const direction = block.getAttribute('dir')?.toLowerCase();
        const container = block.matches('ul,ol,li,blockquote');
        if ((direction === 'ltr' || direction === 'rtl' || direction === 'auto' && !container) && !block.hasAttribute('data-nv-auto-direction')) continue;
        const explicit = block.style.direction;
        const inherited = block.parentElement?.closest('[dir="ltr"],[dir="rtl"],[style*="direction"]');
        const inheritedStyle = inherited?.style.direction;
        if (!explicit && inherited && !inherited.matches('html,body,#editor,.scene-editor,.nl-prose') &&
            (!inherited.hasAttribute('data-nv-auto-direction') || inheritedStyle === 'ltr' || inheritedStyle === 'rtl')) continue;
        if (!block.hasAttribute('data-nv-auto-direction')) block.setAttribute('data-nv-auto-direction', direction === 'auto' ? 'auto' : '');
        block.setAttribute('dir', explicit === 'rtl' || explicit === 'ltr' ? explicit : 'auto');
        updateProseContainer(block);
    }
}

function updateProseContainer(block) {
    if (!block.matches('ul,ol,li,blockquote') || !block.hasAttribute('data-nv-auto-direction')) return;
    if (block.style.direction === 'ltr' || block.style.direction === 'rtl') return;
    const probe = document.createElement('bdi');
    probe.dir = 'auto';
    probe.textContent = block.textContent;
    block.dir = probe.matches(':dir(rtl)') ? 'rtl' : 'ltr';
}

function stripRuntimeProseDirection(root) {
    for (const block of root.querySelectorAll('[data-nv-auto-direction]')) {
        if (block.getAttribute('data-nv-auto-direction') === 'auto') block.setAttribute('dir', 'auto');
        else block.removeAttribute('dir');
        block.removeAttribute('data-nv-auto-direction');
    }
}

window.applyProseDirection = applyProseDirection;
window.stripRuntimeProseDirection = stripRuntimeProseDirection;
const proseDirectionObserver = new MutationObserver(records => {
    for (const record of records) {
        for (const node of record.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) applyProseDirection(node);
        }
        let ancestor = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        while (ancestor && !ancestor.matches('#editor,.scene-editor,.writing-scene')) {
            updateProseContainer(ancestor);
            ancestor = ancestor.parentElement;
        }
    }
});
for (const root of document.querySelectorAll('#editor,#manuscript-content')) {
    proseDirectionObserver.observe(root, { childList: true, characterData: true, subtree: true });
}
