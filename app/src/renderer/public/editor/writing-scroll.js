'use strict';

(() => {
    const viewport = document.querySelector('#editor-wrapper, #manuscript-wrapper');
    let pendingPosition = null;

    window.setWritingScroll = (top, left = viewport.scrollLeft) => {
        const beforeTop = viewport.scrollTop;
        const beforeLeft = viewport.scrollLeft;
        viewport.scrollTop = top;
        viewport.scrollLeft = left;
        if (viewport.scrollTop !== beforeTop || viewport.scrollLeft !== beforeLeft) {
            // Read back the browser's clamped position. Multiple writes can
            // share one scroll event, whose delivery has no time limit.
            pendingPosition = { top: viewport.scrollTop, left: viewport.scrollLeft };
        }
    };

    window.consumeWritingScroll = () => {
        const expected = pendingPosition;
        pendingPosition = null;
        return expected !== null && viewport.scrollTop === expected.top && viewport.scrollLeft === expected.left;
    };

    viewport.addEventListener('wheel', event => {
        if (!event.ctrlKey) pendingPosition = null;
    }, { passive: true });
})();
