const { contextBridge, webFrame } = require('electron')
const inserted = new Map()
const fixedOwners = new WeakMap()
let installations = 0

function frame(pane) {
  if (pane !== 0 && pane !== 1) throw new Error('Unexpected fixture pane.')
  if (location.href !== 'http://127.0.0.1:38917/harness') throw new Error('Unexpected fixture host.')
  const selector = `iframe:nth-of-type(${pane + 1})`
  if (document.querySelector(selector)?.src !== 'http://127.0.0.1:38917/editor/editor.html') throw new Error('Unexpected fixture frame.')
  const target = webFrame.getFrameForSelector(selector)
  if (!target) throw new Error('Fixture frame is not in this renderer process.')
  return target
}

function remove(pane) {
  const target = frame(pane)
  const previous = inserted.get(pane)
  if (previous) target.removeInsertedCSS(previous)
  inserted.delete(pane)
}

function validateMargin(marginBottom) {
  if (!Number.isFinite(marginBottom) || marginBottom < 0 || marginBottom > 4096) throw new Error('Invalid fixture spacing.')
}

contextBridge.exposeInMainWorld('writingUserCss', {
  insert(pane, marginBottom) {
    validateMargin(marginBottom)
    remove(pane)
    const css = `#editor > p:first-child, #editor > [data-scene-id] > p:first-child { margin-bottom:${marginBottom}px !important; }`
    inserted.set(pane, frame(pane).insertCSS(css, { cssOrigin: 'user' }))
  },
  remove,
  fixed(pane, enabled, marginBottom) {
    validateMargin(marginBottom)
    if (typeof enabled !== 'boolean') throw new Error('Invalid fixture gate.')
    const target = frame(pane)
    const doc = document.querySelectorAll('iframe')[pane].contentDocument
    let owner = fixedOwners.get(doc)
    if (!owner) {
      target.insertCSS('body[data-writing-css-spacing] #editor > [data-scene-id] > p:first-child { margin-bottom:var(--writing-css-margin) !important; }', { cssOrigin: 'user' })
      owner = ++installations
      fixedOwners.set(doc, owner)
    }
    doc.body.toggleAttribute('data-writing-css-spacing', enabled)
    if (enabled) doc.body.style.setProperty('--writing-css-margin', `${marginBottom}px`)
    else doc.body.style.removeProperty('--writing-css-margin')
    return { owner, installations }
  }
})
