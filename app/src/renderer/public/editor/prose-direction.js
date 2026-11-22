'use strict';

const PROSE_SELECTOR = 'p,div,h1,h2,h3,h4,h5,h6,blockquote,li,ul,ol,pre';

function applyProseDirection(root) {
    const blocks = Array.from(root.querySelectorAll(PROSE_SELECTOR));
    if (root.matches?.(PROSE_SELECTOR)) blocks.unshift(root);
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

function interfaceDirection() {
    return document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr';
}

function hasLetter(text) {
    return /\p{L}/u.test(text);
}

function resolvedDirection(element) {
    if (element.isConnected) return getComputedStyle(element).direction === 'rtl' ? 'rtl' : 'ltr';
    const explicit = element.style.direction || element.getAttribute('dir');
    if (explicit === 'rtl' || explicit === 'ltr') return explicit;
    return textDirection(element.textContent);
}

function textDirection(text) {
    const probe = document.createElement('bdi');
    probe.dir = 'auto';
    probe.textContent = text;
    return probe.matches(':dir(rtl)') ? 'rtl' : 'ltr';
}

// Chromium resolves dir="auto" to LTR for a block with no letter, whatever the
// parent says. A letterless block continues the script the writer is in: the
// nearest preceding block of the same scene that has a letter, else the interface.
function fallbackDirection(block) {
    const scene = block.closest('[data-writing-scene],.scene-editor,.nl-prose,#editor,#manuscript-content') || block.getRootNode();
    const blocks = Array.from(scene.querySelectorAll(PROSE_SELECTOR));
    for (let index = blocks.indexOf(block) - 1; index >= 0; index--) {
        const previous = blocks[index];
        if (previous.matches('ul,ol') || previous.contains(block) || !hasLetter(previous.textContent)) continue;
        return resolvedDirection(previous);
    }
    return interfaceDirection();
}

function updateProseContainer(block) {
    if (!block.hasAttribute('data-nv-auto-direction')) return;
    if (block.style.direction === 'ltr' || block.style.direction === 'rtl') return;
    if (!hasLetter(block.textContent)) {
        block.dir = fallbackDirection(block);
        return;
    }
    if (!block.matches('ul,ol,li,blockquote')) {
        block.dir = 'auto';
        return;
    }
    block.dir = textDirection(block.textContent);
}

function refreshProseDirection() {
    for (const block of document.querySelectorAll('[data-nv-auto-direction]')) updateProseContainer(block);
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
window.refreshProseDirection = refreshProseDirection;
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
