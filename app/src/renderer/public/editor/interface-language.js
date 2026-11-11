'use strict';

window.setInterfaceLanguage = function (language, direction) {
    document.documentElement.lang = language || 'en';
    document.documentElement.dir = direction === 'rtl' ? 'rtl' : 'ltr';
    for (const chrome of document.querySelectorAll('[data-editor-chrome]')) chrome.lang = document.documentElement.lang;
};
