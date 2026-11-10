import type { WritingComment } from '../views/editor/writingTypes'

export interface InboxItem {
  chapterGuid: string
  chapterTitle: string
  sceneId: string
  sceneTitle: string
  commentId: string
  anchorText: string
  text: string
  author: string
  isTodo: boolean
  resolved: boolean
  createdAt: string
  replies: NonNullable<WritingComment['replies']>
  verdict: string
}

export type InboxAction = { kind: 'todo' | 'resolved'; value: boolean }
  | { kind: 'verdict'; value: '' | 'accepted' | 'considering' | 'declined' }
  | { kind: 'reply'; text: string }

export function changeInboxComment(comment: WritingComment, action: InboxAction, author: string): void {
  if (action.kind === 'todo') comment.isTodo = action.value
  if (action.kind === 'resolved') comment.resolved = action.value
  if (action.kind === 'verdict') {
    comment.verdict = action.value || null
    if (action.value === 'accepted' || action.value === 'declined') comment.resolved = true
  }
  if (action.kind === 'reply') {
    const text = action.text.trim()
    if (!text) throw new Error('A reply needs text.')
    comment.replies = [...comment.replies ?? [], { id: crypto.randomUUID(), author, text, createdAt: new Date().toISOString() }]
  }
}
