'use strict';

const shortcutPunctuation = {
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
    Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`', Minus: '-', Equal: '='
};

globalThis.NovalistShortcutKeys = {
    key(event) {
        if (event.isComposing || event.keyCode === 229 || event.altGraph ||
            event.getModifierState?.('AltGraph')) return null;
        const key = event.key.toLowerCase();
        if (!(event.ctrlKey || event.altKey || event.metaKey) ||
            (key !== '' && !/[^\u0000-\u007f]/u.test(key)) || /\p{Script=Latin}/u.test(key)) return key;
        if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
        if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
        if (Object.hasOwn(shortcutPunctuation, event.code)) return shortcutPunctuation[event.code];
        return key;
    }
};
