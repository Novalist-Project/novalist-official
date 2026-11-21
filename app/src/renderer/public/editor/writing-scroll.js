'use strict';

(() => {
    const viewport = document.querySelector('#editor-wrapper, #manuscript-wrapper');
    let pendingPosition = null;

    function trackWritingScroll(operation) {
        const beforeTop = viewport.scrollTop;
        const beforeLeft = viewport.scrollLeft;
        operation();
        if (viewport.scrollTop !== beforeTop || viewport.scrollLeft !== beforeLeft) {
            // Read back the browser's clamped position. Multiple writes can
            // share one scroll event, whose delivery has no time limit.
            pendingPosition = { top: viewport.scrollTop, left: viewport.scrollLeft };
        }
    }

    window.setWritingScroll = (top, left = viewport.scrollLeft) => trackWritingScroll(() => {
        viewport.scrollTop = top;
        viewport.scrollLeft = left;
    });

    window.scrollWritingIntoView = (element, options) => trackWritingScroll(() => element.scrollIntoView(options));

    window.consumeWritingScroll = () => {
        const expected = pendingPosition;
        pendingPosition = null;
        return expected !== null && viewport.scrollTop === expected.top && viewport.scrollLeft === expected.left;
    };

    viewport.addEventListener('wheel', event => {
        if (!event.ctrlKey) pendingPosition = null;
    }, { passive: true });
})();
