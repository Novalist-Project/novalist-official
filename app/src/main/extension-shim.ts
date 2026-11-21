/** Where the panel shim is served from, under every extension's own host. */
export const THEME_SHIM_PATH = '/__novalist/theme.js'

/** Whether a request is for the panel shim, wherever the page asking sits. */
export function isThemeShim(pathname: string): boolean {
  return pathname === THEME_SHIM_PATH || pathname.endsWith(THEME_SHIM_PATH)
}

/**
 * The script an extension panel includes to be themed and directed.
 *
 * A panel is an iframe and neither a CSS custom property nor the `dir` and
 * `lang` of the interface cross a document boundary. So the shell posts both in
 * and this stamps them onto the panel's own root element:
 *
 * - the resolved `--nl-*` set, after which `var(--nl-surface-card)` means
 *   inside the panel what it means everywhere else, and a theme change repaints
 *   it with the rest of the app;
 * - the language the extension's strings are in and its reading direction, so
 *   a panel translated into Arabic lays out right to left without the extension
 *   passing a direction around itself. An extension that does not ship the
 *   interface language is told English, because English is what it will show.
 *
 * Synthesised here rather than shipped as a file: it then has no packaging
 * story, works identically in dev and in a packaged build, and cannot go
 * missing from an extension folder.
 *
 * The ready ping matters. The shell cannot know when this has run, and a
 * message posted before the listener existed would be lost - leaving the panel
 * unstyled until the writer happened to change theme.
 */
export const THEME_SHIM = `(function () {
  var root = document.documentElement;
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data) return;
    var language = data.novalistLanguage;
    if (language && typeof language.lang === 'string' && language.lang) {
      root.setAttribute('lang', language.lang);
      root.setAttribute('dir', language.dir === 'rtl' ? 'rtl' : 'ltr');
    }
    var tokens = data.novalistTheme;
    if (!tokens) return;
    for (var name in tokens) {
      if (Object.prototype.hasOwnProperty.call(tokens, name)) {
        root.style.setProperty(name, tokens[name]);
      }
    }
    root.setAttribute('data-novalist-theme', 'ready');
  });
  parent.postMessage({ novalistThemeReady: true }, '*');
})();
`
