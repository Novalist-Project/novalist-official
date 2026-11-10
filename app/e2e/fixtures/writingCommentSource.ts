export function sceneCommentSource(name: string, source: string): string {
  const edits: Record<string, [string, string][]> = {
    'comment-gutter-events.js': [
      ['function (data) {', 'function (data, sceneId = window.writingComments.active()) {'],
      ['commentsState.clear();', 'for (const key of commentsState.keys()) if (JSON.parse(key)[0] === sceneId) commentsState.delete(key);'],
      ['commentsState.set(c.id, {', 'commentsState.set(window.writingComments.key(c.id, sceneId), {'],
      ['if (!c || !c.id) return;', 'if (!c || !c.id) return;\n            window.writingComments.reserve(c.id, sceneId);'],
      ["window.NovalistEditorState.editor.querySelectorAll('span.nv-comment[data-comment-id]')", 'window.writingComments.marks(sceneId)'],
      ["commentsState.has(span.getAttribute('data-comment-id'))", "commentsState.has(window.writingComments.key(span.getAttribute('data-comment-id'), sceneId))"]
    ],
    'annotations.js': [
      ['function removeCommentSpan(commentId) {', 'function removeCommentSpan(commentId, sceneId = window.writingComments.active()) {'],
      ["window.NovalistEditorState.editor.querySelectorAll('span.nv-comment[data-comment-id]')", 'window.writingComments.marks(sceneId)'],
      ['commentsState.delete(commentId)', 'commentsState.delete(window.writingComments.key(commentId, sceneId))'],
      ['function scrollToComment(commentId, doScroll) {', 'function scrollToComment(commentId, doScroll, sceneId = window.writingComments.active()) {'],
      ["c.dataset.commentId === commentId", "c.dataset.commentId === commentId && c.dataset.sceneId === sceneId"],
      ["document.querySelector('span.nv-comment[data-comment-id=\"' + commentId + '\"]')", "window.writingComments.marks(sceneId).find(mark => mark.getAttribute('data-comment-id') === commentId)"]
    ],
    'comment-gutter.js': [
      ['function createCommentCard(id, data) {', 'function createCommentCard(id, data, sceneId) {'],
      ['card.dataset.commentId = id;', 'card.dataset.commentId = id;\n    card.dataset.sceneId = sceneId;'],
      ['commentsState.get(id)', 'commentsState.get(window.writingComments.key(id, sceneId))'],
      ["type: 'commentTextChanged', commentId: id", "type: 'commentTextChanged', sceneId, commentId: id"],
      ["type: 'commentDeleted', commentId: id", "type: 'commentDeleted', sceneId, commentId: id"],
      ['window.scrollToComment(id, false)', 'window.scrollToComment(id, false, sceneId)'],
      ['window.scrollToComment(id, true)', 'window.scrollToComment(id, true, sceneId)'],
      ["window.NovalistEditorState.editor.querySelectorAll('span.nv-comment[data-comment-id]')", '(window.writingComments?.allMarks() ?? [])'],
      ["const id = s.getAttribute('data-comment-id');", "const id = s.getAttribute('data-comment-id');\n        const sceneId = window.writingComments.owner(s);\n        const key = window.writingComments.key(id, sceneId);"],
      ['commentsState.has(id) || liveIds.has(id)', 'commentsState.has(key) || liveIds.has(key)'],
      ['liveIds.add(id);', 'liveIds.add(key);'],
      ['items.push({ id, anchor: s });', 'items.push({ id, key, sceneId, anchor: s });'],
      ['have.set(c.dataset.commentId, c)', 'have.set(window.writingComments.key(c.dataset.commentId, c.dataset.sceneId), c)'],
      ['commentsState.get(item.id)', 'commentsState.get(item.key)'],
      ['have.get(item.id)', 'have.get(item.key)'],
      ['createCommentCard(item.id, data)', 'createCommentCard(item.id, data, item.sceneId)']
    ]
  }
  for (const [before, after] of edits[name] ?? []) {
    if (source.split(before).length !== 2) throw new Error('The scene comment metadata seam no longer matches its exact source.')
    source = source.replace(before, after)
  }
  return source
}
