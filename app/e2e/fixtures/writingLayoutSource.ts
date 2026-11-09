import { parse } from '@babel/parser'
import { VISITOR_KEYS, type Node } from '@babel/types'

export function instrumentBodies(name: string, source: string, targets: string[]): string {
  const parsed = parse(source, { sourceType: 'unambiguous', plugins: ['typescript'] })
  const edits: { position: number; text: string }[] = []
  const counts = new Map(targets.map(target => [target, 0]))
  const visit = (node: Node, ancestors: Node[]): void => {
    const parent = ancestors.at(-1)
    let key: string | undefined
    let body: { start?: number | null; end?: number | null } | undefined
    if (node.type === 'FunctionDeclaration' && node.id) { key = node.id.name; body = node.body }
    if (node.type === 'ClassMethod') {
      const owner = ancestors.at(-2)
      if (owner?.type === 'ClassDeclaration' && owner.id && node.key.type === 'Identifier') { key = owner.id.name + '.' + node.key.name; body = node.body }
    }
    if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
      if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier') key = parent.id.name
      if (parent?.type === 'CallExpression') key = 'callback:' + source.slice(parent.callee.start!, parent.callee.end!)
      if (parent?.type === 'AssignmentExpression') key = 'assignment:' + source.slice(parent.left.start!, parent.left.end!)
      if (node.body.type === 'BlockStatement') body = node.body
    }
    if (key && counts.has(key) && body) {
      if (source.includes('__writingLayoutSpan')) throw new Error('Layout source already instrumented.')
      counts.set(key, counts.get(key)! + 1)
      edits.push({ position: body.start! + 1, text: `const __writingLayoutSpan=globalThis.__writingLayout.enter(${JSON.stringify(name + ':' + key)});try{` },
        { position: body.end! - 1, text: '}finally{globalThis.__writingLayout.exit(__writingLayoutSpan);}' })
    }
    for (const childKey of VISITOR_KEYS[node.type] ?? []) {
      const child = Reflect.get(node, childKey)
      for (const value of Array.isArray(child) ? child : [child]) if (value) visit(value, [...ancestors, node])
    }
  }
  visit(parsed, [])
  for (const [key, count] of counts) if (count !== 1) throw new Error(`Layout seam ${name}:${key} expected 1 body, found ${count}.`)
  for (const edit of edits.sort((a, b) => b.position - a.position)) source = source.slice(0, edit.position) + edit.text + source.slice(edit.position)
  return source
}

const bodies: Record<string, string[]> = {
  'comment-gutter.js': ['scheduleCommentRender', 'renderCommentGutter', 'createCommentCard'],
  'typewriter-scroll.js': ['updateFocusBlock', 'scheduleTypewriterRecenter', 'recenterCaret'],
  'writing-zoom.js': ['caretPosition', 'restoreCaretAnchor', 'resizeSurface', 'refresh', 'scheduleRefresh'],
  'dialogue-input.js': ['getCaretPosition', 'tryDialogueCorrection'],
  'formatting.js': ['selectedBlocks', 'getFormattingState', 'notifyFormattingChanged'],
  'read-aloud.js': ['proseBlocks'],
  'readability.js': ['requestReadability', 'reapplyReadability', 'paintReadability', 'callback:setTimeout'],
  'grammar-corrections.js': ['requestGrammarCheck', 'callback:setTimeout'],
  'grammar-highlights.js': ['buildGrammarPlainTextMap'],
  'content-input.js': ['getCleanContentHtml', 'capturePendingContentChange', 'reportContentChanged', 'handleEditorInput'],
  'page-layout.js': ['repaginatePageView', 'unwrapPages', 'captureSelectionForRepaginate', 'restoreSelectionForRepaginate'],
  'writingExperiment.ts': ['CompoundHistory.capture', 'ExperimentPane.capture', 'ExperimentPane.markDirty', 'ExperimentPane.point', 'ExperimentPane.selection', 'ExperimentPane.restore', 'ExperimentPane.selectedRanges', 'ExperimentPane.activeScene', 'ExperimentPane.render', 'callback:state.text.observe'],
  'writingSceneCapture.ts': ['serialize', 'capture', 'assignment:editor.reportContentChanged'],
  'writingPageLayout.ts': ['unwrapPages', 'paginateScene', 'paginate'],
  'sceneMarkup.ts': ['SceneMarkup.read', 'SceneMarkup.position', 'SceneMarkup.domPosition', 'SceneMarkup.render'],
  'richText.ts': ['updateRichText']
}

const expressions: Record<string, [string, string][]> = {
  'comment-gutter.js': [
    ["window.NovalistEditorState.editor.querySelectorAll('span.nv-comment[data-comment-id]')", 'globalThis.__writingLayout.measure("comment.anchorScan",()=>window.NovalistEditorState.editor.querySelectorAll(\'span.nv-comment[data-comment-id]\'))'],
    ['item.anchor.getBoundingClientRect()', 'globalThis.__writingLayout.rect("comment.anchorRect",()=>item.anchor.getBoundingClientRect(),innerHeight)'],
    ['card.offsetHeight', 'globalThis.__writingLayout.measure("comment.cardHeight",()=>card.offsetHeight)'],
    ["card.style.top = desired + 'px';", 'globalThis.__writingLayout.count("comment.positionWrites"); card.style.top = desired + \'px\';'],
    ['items.sort(', 'globalThis.__writingLayout.count("comment.anchors",items.length); items.sort(']
  ],
  'read-aloud.js': [['return blocks;', 'return globalThis.__writingLayout.value("focus.proseBlocks",blocks);']],
  'dialogue-input.js': [['const textBefore = preRange.toString();', 'const textBefore = globalThis.__writingLayout.value("caret.prefixChars",globalThis.__writingLayout.measure("caret.prefixCopy",()=>preRange.toString()));']],
  'typewriter-scroll.js': [
    ['range.getBoundingClientRect()', 'globalThis.__writingLayout.measure("typewriter.caretRect",()=>range.getBoundingClientRect())'],
    ['window.NovalistEditorState.wrapper.getBoundingClientRect()', 'globalThis.__writingLayout.measure("typewriter.wrapperRect",()=>window.NovalistEditorState.wrapper.getBoundingClientRect())']
  ],
  'writingSceneCapture.ts': [['scene.innerText', 'globalThis.__writingLayout.measure("capture.innerText",()=>scene.innerText)']],
  'writingPageLayout.ts': [
    ['presentation.append(measuringPage, ...blocks)', 'globalThis.__writingLayout.measure("page.measureWrites",()=>presentation.append(measuringPage, ...blocks))'],
    ['block.offsetHeight', 'globalThis.__writingLayout.measure("page.heightRead",()=>block.offsetHeight)'],
    ['const heights = blocks.map', 'globalThis.__writingLayout.count("page.atoms",blocks.length); const heights = blocks.map'],
    ['presentation.append(page, block)', 'globalThis.__writingLayout.count("page.blockMoves"); globalThis.__writingLayout.measure("page.commitWrite",()=>presentation.append(page, block))'],
    ['selection!.setBaseAndExtent(saved.anchor, saved.anchorOffset, saved.focus, saved.focusOffset)', 'globalThis.__writingLayout.measure("page.selectionRestore",()=>selection!.setBaseAndExtent(saved.anchor, saved.anchorOffset, saved.focus, saved.focusOffset))'],
    ["presentation.remove(measuringPage)", 'globalThis.__writingLayout.count("page.scenes"); presentation.remove(measuringPage)']
  ]
}

export function profileWritingSource(name: string, source: string): string {
  for (const [before, after] of expressions[name] ?? []) {
    const count = source.split(before).length - 1
    if (count !== 1) throw new Error(`Layout expression seam ${name}:${before} expected 1, found ${count}.`)
    source = source.replace(before, after)
  }
  return bodies[name] ? instrumentBodies(name, source, bodies[name]) : source
}

export const layoutSourceNames = Object.keys(bodies)
