'use strict';

function isTextEditingShortcut(e) {
    // Cmd is the editing modifier on Apple platforms, so it must reserve the same
    // native shortcuts (Cmd+C/V/X/Z/A) that Ctrl does elsewhere.
    if (!e.ctrlKey && !e.metaKey) return false;
    var k = window.NovalistShortcutKeys.key(e);
    if (k === null) return false;
    // Navigation keys that should be handled natively by contenteditable:
    // Ctrl+Arrow walks by word, Ctrl+Shift+Arrow selects by word, Ctrl+Home and
    // Ctrl+End go to the ends. Alt is the exception - contenteditable does
    // nothing with Ctrl+Alt+Arrow, and reserving it anyway meant the pane
    // splitting gestures died the moment the caret was in the prose, which is
    // the only place a writer ever presses them from.
    var navKeys = ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end'];
    if (navKeys.includes(k)) return !e.altKey;
    // Ctrl+(no shift): select-all, copy, paste, cut, undo, redo. On Apple
    // keyboards Cmd+B/I/U are the system bold/italic/underline gestures and
    // contenteditable applies them natively, so they stay reserved: the result
    // is the same mark the host would have applied, by the route a Mac writer
    // expects. Ctrl+B/I/U elsewhere are forwarded and the host applies them.
    if (!e.shiftKey && !e.altKey) {
        if (e.ctrlKey && (k === 'backspace' || k === 'delete')) return true;
        return 'acvxzy'.includes(k) || (e.metaKey && !e.ctrlKey && 'biu'.includes(k));
    }
    // Ctrl+Shift+Z = redo
    if (e.shiftKey && !e.altKey && k === 'z') return true;
    return false;
}

function pastedTextBlocks(text, container) {
    for (const line of text.split(/\r\n|[\r\n\u2029]/)) {
        const paragraph = document.createElement('p');
        if (line) paragraph.textContent = line;
        else paragraph.append(document.createElement('br'));
        container.append(paragraph);
    }
    return container;
}

function normalizePastedBlocks(container) {
    const blocks = 'p,div,ul,ol,blockquote,h1,h2,h3,h4,h5,h6';
    // Web pages often put the whole selection inside a layout div. The
    // editor gives each direct prose block its own paragraph style.
    for (const wrapper of Array.from(container.querySelectorAll('div,span,b,strong,i,em,u')).reverse()) {
        const hasBlocks = Array.from(wrapper.children).some(child => child.matches(blocks));
        if (!hasBlocks && wrapper.tagName !== 'DIV') continue;
        if (wrapper.matches('b,strong')) wrapper.style.fontWeight ||= 'bold';
        if (wrapper.matches('i,em')) wrapper.style.fontStyle ||= 'italic';
        if (wrapper.matches('u')) wrapper.style.textDecoration ||= 'underline';
        const fragment = document.createDocumentFragment();
        if (!hasBlocks && /[\r\n\u2029]/.test(wrapper.textContent) && !wrapper.querySelector(':not(span),[dir],[style]')) {
            wrapper.replaceChildren(pastedTextBlocks(wrapper.textContent, document.createDocumentFragment()));
        }
        let paragraph;
        for (const child of Array.from(wrapper.childNodes)) {
            if (child.matches?.(blocks)) {
                paragraph = null;
                fragment.append(child);
            } else {
                if (!paragraph && hasBlocks && child.nodeType === Node.TEXT_NODE &&
                    /^[\t\r\n ]+$/.test(child.data) && (!child.nextSibling || child.nextSibling.matches?.(blocks))) continue;
                if (!paragraph) {
                    paragraph = document.createElement('p');
                    fragment.append(paragraph);
                }
                paragraph.append(child);
            }
        }
        if (!fragment.firstChild) fragment.append(document.createElement('p'));
        for (const block of Array.from(fragment.children)) {
            if (wrapper.dir && !block.dir) block.dir = wrapper.dir;
            for (const property of wrapper.style) {
                if (!block.style.getPropertyValue(property)) block.style.setProperty(property, wrapper.style.getPropertyValue(property));
            }
        }
        wrapper.replaceWith(fragment);
    }
}

function sanitizePastedHtml(html) {
    const tmp = document.createElement('div');
    tmp.replaceChildren(window.sanitizeSceneFragment(html));

    // Remove all style attributes except basic formatting
    const allElements = tmp.querySelectorAll('*');
    for (const el of allElements) {
        // Keep b, i, u, strong, em, p, br, div, span
        const tag = el.tagName.toLowerCase();
        const allowedTags = ['b', 'i', 'u', 'strong', 'em', 'p', 'br', 'div', 'span', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
        if (!allowedTags.includes(tag)) {
            // Replace with its text content
            el.replaceWith(...el.childNodes);
            continue;
        }
        // Remove all attributes except style with basic formatting
        const style = el.getAttribute('style');
        const direction = el.getAttribute('dir');
        const validDirection = /^(ltr|rtl|auto)$/i.test(direction ?? '') ? direction.toLowerCase() : el.style.direction;
        // Clear all attributes
        while (el.attributes.length > 0) el.removeAttribute(el.attributes[0].name);
        if (/^(ltr|rtl|auto)$/.test(validDirection)) el.setAttribute('dir', validDirection);
        if (style) {
            // Only keep font-weight, font-style, text-decoration, text-align
            const allowed = {};
            if (/font-weight\s*:\s*bold/i.test(style)) allowed['font-weight'] = 'bold';
            else if (el.matches('b,strong') && /font-weight\s*:\s*(normal|400)/i.test(style)) allowed['font-weight'] = 'normal';
            if (/font-style\s*:\s*italic/i.test(style)) allowed['font-style'] = 'italic';
            if (/text-decoration\s*:\s*underline/i.test(style)) allowed['text-decoration'] = 'underline';
            const alignMatch = style.match(/text-align\s*:\s*(left|center|right|justify)/i);
            if (alignMatch) allowed['text-align'] = alignMatch[1];
            const parts = Object.entries(allowed).map(([k, v]) => k + ':' + v);
            if (parts.length > 0) el.setAttribute('style', parts.join(';'));
        }
    }
    if (/[\r\n\u2029]/.test(tmp.textContent) && !tmp.querySelector(':not(span),[dir],[style]')) {
        return pastedTextBlocks(tmp.textContent, document.createElement('div')).innerHTML;
    }
    normalizePastedBlocks(tmp);
    window.applyProseDirection?.(tmp);
    return tmp.innerHTML;
}

function mergePastedParagraphEdge(target, original, edge, prepend) {
    const contents = edge.cloneContents();
    if (!contents.textContent && !contents.querySelector('br,img,hr,sup')) return;
    if (target.childNodes.length === 1 && target.firstChild.nodeName === 'BR') target.replaceChildren();
    if (original.className) target.className = original.className;
    if (original.style.cssText) target.style.cssText = original.style.cssText + ';' + target.style.cssText;
    if (original.dir && !original.hasAttribute('data-nv-auto-direction') && (!target.dir || target.hasAttribute('data-nv-auto-direction'))) {
        target.removeAttribute('data-nv-auto-direction');
        target.dir = original.dir;
    }
    if (prepend) target.prepend(contents);
    else target.append(contents);
}

function insertParagraphsWithLineBreaks(html) {
    // Chromium joins a rich fragment to surrounding prose by visual line,
    // promoting <br> in the first or last paragraph into a paragraph break.
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    const start = window.blockOf(range.startContainer);
    const end = window.blockOf(range.endContainer);
    if (start?.tagName !== 'P' || end?.tagName !== 'P' || start.parentNode !== end.parentNode) return false;
    const fragment = window.sanitizeSceneFragment(html);
    const first = fragment.firstElementChild, last = fragment.lastElementChild;
    if (first === last || first?.tagName !== 'P' || last?.tagName !== 'P') return false;
    const prefix = range.cloneRange();
    prefix.selectNodeContents(start);
    prefix.setEnd(range.startContainer, range.startOffset);
    const suffix = range.cloneRange();
    suffix.selectNodeContents(end);
    suffix.setStart(range.endContainer, range.endOffset);
    if (!prefix.toString() && !suffix.toString()) return false;
    mergePastedParagraphEdge(first, start, prefix, true);
    const caret = last.childNodes.length === 1 && last.firstChild.nodeName === 'BR' ? 0 : last.childNodes.length;
    mergePastedParagraphEdge(last, end, suffix, false);
    range.setStartBefore(start);
    range.setEndAfter(end);
    range.deleteContents();
    range.insertNode(fragment);
    selection.collapse(last, caret);
    window.NovalistEditorState.editor.dispatchEvent(new Event('input'));
    return true;
}

function insertPastedContent(html, text) {
    if (!html && !text) return false;
    if (window.NovalistEditorState.suggestionMode) {
        const proposed = text || window.writingSceneText(window.sceneContentFragment(html)).replace(/\n$/, '');
        if (!proposed) return false;
        window.insertSuggested(proposed);
        window.NovalistEditorState.editor.dispatchEvent(new Event('input'));
        return true;
    }
    let cleaned = html ? sanitizePastedHtml(html) : '';
    if (!cleaned && /[\r\n\u2029]/.test(text)) cleaned = pastedTextBlocks(text, document.createElement('div')).innerHTML;
    if (!cleaned && !text) return false;
    if (window.NovalistWritingDocument?.enabled) {
        if (!window.prepareWritingPaste()) return false;
        if (html && cleaned.includes('<br') && insertParagraphsWithLineBreaks(cleaned)) return true;
    }
    if (cleaned) return document.execCommand('insertHTML', false, cleaned);
    return document.execCommand('insertText', false, text);
}

function focusEditor() {
    window.NovalistEditorState.editor.focus({ preventScroll: true });
}

Object.assign(window, {
    isTextEditingShortcut,
    insertPastedContent,
    sanitizePastedHtml,
    focusEditor
});
