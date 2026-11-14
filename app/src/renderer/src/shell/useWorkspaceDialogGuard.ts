import { useLayoutEffect, useRef } from 'react'
import { useMotionPresent } from './MotionPresence'

const drafts = new Map<symbol, () => string | undefined>()

/** Typed dialog drafts have no safe target after another window changes scope. */
export function hasWorkspaceDialogDraft(): boolean {
  return drafts.size > 0
}

export function revealWorkspaceDialogDraft(): string | undefined {
  for (const reveal of drafts.values()) {
    const message = reveal()
    if (message) return message
  }
  return undefined
}

export function useWorkspaceDialogGuard(active = true, onBlocked?: () => string): (operation: () => Promise<void>) => Promise<void> {
  const present = useMotionPresent()
  const token = useRef(Symbol('workspace dialog'))
  const registered = useRef(false)
  const reveal = useRef(onBlocked)
  reveal.current = onBlocked
  const revealDraft = (): string | undefined => reveal.current?.()
  useLayoutEffect(() => {
    if (!active || !present) return
    const draft = token.current
    registered.current = true
    drafts.set(draft, revealDraft)
    return () => { registered.current = false; drafts.delete(draft) }
  }, [active, present])
  return async operation => {
    drafts.delete(token.current)
    try { await operation() }
    finally { if (registered.current) drafts.set(token.current, revealDraft) }
  }
}
