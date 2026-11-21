import { MODE_VIEWS } from '../shell/modes'
import type { PaneNode, PaneView } from './shellTypes'
import type { WritingScope } from '../views/editor/writingTypes'

export type PersistedPaneLayout = PaneNode
const views = new Set<string>([
  ...Object.values(MODE_VIEWS).flat(), 'manuscript', 'dashboard', 'settings', 'about', 'extensions', 'sceneNotes'
])

export function normalizeWritingDestination(view: unknown, scope: unknown, desktop = true): {
  view: PaneView; writingScope?: WritingScope
} {
  const known = typeof view === 'string' && views.has(view) ? view as PaneView : 'write'
  if (desktop && known === 'manuscript') return { view: 'write', writingScope: 'manuscript' }
  if (known !== 'write') return { view: known }
  return { view: known, writingScope: scope === 'scene' || scope === 'chapter' ? scope : 'manuscript' }
}

/** Validates saved UI state; project identity and prose never enter a pane layout. */
export function normalizeWritingLayout(input: unknown, desktop = true): PersistedPaneLayout {
  const ids = new Set<string>()
  let sequence = 0
  const identify = (value: unknown): string => {
    let id = typeof value === 'string' && value ? value : ''
    while (!id || ids.has(id)) id = `writing-pane-${++sequence}`
    ids.add(id)
    return id
  }
  const visit = (value: unknown, depth: number): PaneNode => {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const id = identify(record.id)
    if (record.kind !== 'split' || !Array.isArray(record.children) || !record.children.length || depth > 32) {
      return { kind: 'leaf', id, ...normalizeWritingDestination(record.view, record.writingScope, desktop) }
    }
    const children = record.children.map(child => visit(child, depth + 1))
    if (children.length === 1) return children[0]
    const raw = record.sizes
    const sizes = Array.isArray(raw) && raw.length === children.length
      && raw.every(size => typeof size === 'number' && Number.isFinite(size) && size > 0)
      ? raw as number[] : children.map(() => 1)
    const total = sizes.reduce((sum, size) => sum + size, 0)
    const maximum = sizes.reduce((largest, size) => Math.max(largest, size), 0)
    const scaled = sizes.map(size => Math.max(Number.MIN_VALUE, size / maximum))
    const scaledTotal = scaled.reduce((sum, size) => sum + size, 0)
    return { kind: 'split', id, direction: record.direction === 'column' ? 'column' : 'row',
      children, sizes: Math.abs(total - 100) < 1e-9 ? sizes.slice()
        : scaled.map(size => Math.max(Number.MIN_VALUE, size / scaledTotal * 100)) }
  }
  return visit(input, 0)
}
