import type { DetachedPaneRequest } from './detachedPane'

/**
 * What an undocked window shows, in a form that can be saved with a workspace
 * layout or remembered for a project and shown again later.
 *
 * Identifiers and view names only: no project path, title or any text the
 * writer typed. A scene is named by its chapter and scene ids, and comes back
 * only when the open project still has it.
 */
export type PaneWindowScope = 'scene' | 'chapter' | 'manuscript'

export type PaneWindowNode =
  | { kind: 'leaf'; id: string; view: string; writingScope?: PaneWindowScope }
  | { kind: 'split'; id: string; direction: 'row' | 'column'; children: PaneWindowNode[]; sizes: number[] }

export interface PaneWindowScene {
  /** Index of the leaf, left to right and top to bottom. */
  pane: number
  chapterGuid: string
  sceneId: string
}

export interface PaneWindowExtensionView {
  extensionId: string
  key: string
}

export interface PaneWindowContent {
  panes: PaneWindowNode
  activePane: number
  scenes: PaneWindowScene[]
  selectedSceneIds: string[] | null
  extView: PaneWindowExtensionView | null
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PaneWindowPlacement {
  bounds: WindowBounds
  maximized: boolean
  /** The work area of the display the window was on when it was recorded. */
  workArea: WindowBounds | null
}

export interface SavedPaneWindow {
  content: PaneWindowContent
  placement: PaneWindowPlacement | null
}

/** More windows than anyone arranges by hand; bounds a corrupt or hostile record. */
export const MAX_PANE_WINDOWS = 16
const MAX_DEPTH = 16
const MAX_CHILDREN = 16
/** Far more panes than fit on a screen; bounds what one window can record. */
export const MAX_PANE_LEAVES = 64
/** A selected run longer than any manuscript has scenes is not a selection. */
export const MAX_SELECTED_SCENES = 10_000
const MAX_ID = 128
const VIEW = /^[a-zA-Z]{1,40}$/

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function id(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID ? value : null
}

function scope(value: unknown): PaneWindowScope | undefined {
  return value === 'scene' || value === 'chapter' || value === 'manuscript' ? value : undefined
}

export function normalizePaneWindowNode(input: unknown, depth = 0, budget = { leaves: MAX_PANE_LEAVES }): PaneWindowNode | null {
  const node = record(input)
  if (!node || depth > MAX_DEPTH) return null
  const nodeId = id(node.id) ?? `pane-${depth}`
  if (node.kind === 'leaf') {
    if (typeof node.view !== 'string' || !VIEW.test(node.view) || --budget.leaves < 0) return null
    const writingScope = scope(node.writingScope)
    return { kind: 'leaf', id: nodeId, view: node.view, ...(writingScope ? { writingScope } : {}) }
  }
  if (node.kind !== 'split' || (node.direction !== 'row' && node.direction !== 'column')) return null
  if (!Array.isArray(node.children) || node.children.length < 2 || node.children.length > MAX_CHILDREN) return null
  if (!Array.isArray(node.sizes) || node.sizes.length !== node.children.length) return null
  const sizes = node.sizes.map(Number)
  if (!sizes.every((size) => Number.isFinite(size) && size > 0 && size <= 100)) return null
  const children: PaneWindowNode[] = []
  for (const child of node.children) {
    const normalized = normalizePaneWindowNode(child, depth + 1, budget)
    if (!normalized) return null
    children.push(normalized)
  }
  return { kind: 'split', id: nodeId, direction: node.direction, children, sizes }
}

export function paneWindowLeaves(node: PaneWindowNode): Extract<PaneWindowNode, { kind: 'leaf' }>[] {
  return node.kind === 'leaf' ? [node] : node.children.flatMap(paneWindowLeaves)
}

export function normalizePaneWindowContent(input: unknown): PaneWindowContent | null {
  const value = record(input)
  const panes = value && normalizePaneWindowNode(value.panes)
  if (!value || !panes) return null
  const count = paneWindowLeaves(panes).length
  const activePane = Number.isInteger(value.activePane) && (value.activePane as number) >= 0 && (value.activePane as number) < count
    ? value.activePane as number : 0
  // One scene per pane: the first entry for a pane wins, so the list never
  // outgrows the tree it describes.
  const scenes = new Map<number, PaneWindowScene>()
  for (const entry of Array.isArray(value.scenes) ? value.scenes : []) {
    if (scenes.size >= count) break
    const scene = record(entry)
    const chapterGuid = scene && id(scene.chapterGuid)
    const sceneId = scene && id(scene.sceneId)
    const pane = scene?.pane
    if (chapterGuid && sceneId && Number.isInteger(pane) && (pane as number) >= 0 && (pane as number) < count && !scenes.has(pane as number)) {
      scenes.set(pane as number, { pane: pane as number, chapterGuid, sceneId })
    }
  }
  const selected = value.selectedSceneIds
  const selectedSceneIds = Array.isArray(selected) && selected.length <= MAX_SELECTED_SCENES && selected.every((entry) => id(entry) !== null)
    ? [...new Set(selected as string[])] : null
  const ext = record(value.extView)
  const extensionId = ext && id(ext.extensionId)
  const key = ext && id(ext.key)
  return { panes, activePane, scenes: [...scenes.values()], selectedSceneIds, extView: extensionId && key ? { extensionId, key } : null }
}

function bounds(input: unknown): WindowBounds | null {
  const value = record(input)
  if (!value) return null
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((key) => Number(value[key]))
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) } : null
}

export function normalizePaneWindowPlacement(input: unknown): PaneWindowPlacement | null {
  const value = record(input)
  const windowBounds = value && bounds(value.bounds)
  if (!value || !windowBounds) return null
  return { bounds: windowBounds, maximized: value.maximized === true, workArea: bounds(value.workArea) }
}

export function normalizeSavedPaneWindows(input: unknown): SavedPaneWindow[] {
  if (!Array.isArray(input)) return []
  return input.slice(0, MAX_PANE_WINDOWS).flatMap((entry): SavedPaneWindow[] => {
    const value = record(entry)
    const content = value && normalizePaneWindowContent(value.content)
    return value && content ? [{ content, placement: normalizePaneWindowPlacement(value.placement) }] : []
  })
}

/** The content a window opened by a pop-out request starts with. */
export function contentFromRequest(request: DetachedPaneRequest): PaneWindowContent {
  const view = VIEW.test(request.view) ? request.view : 'write'
  const writingScope = view === 'write' ? request.writingScope ?? 'manuscript' : undefined
  return {
    panes: { kind: 'leaf', id: 'pane-1', view, ...(writingScope ? { writingScope } : {}) },
    activePane: 0,
    scenes: view === 'write' && request.chapterGuid && request.sceneId
      ? [{ pane: 0, chapterGuid: request.chapterGuid, sceneId: request.sceneId }] : [],
    selectedSceneIds: request.selectedSceneIds && request.selectedSceneIds.length <= MAX_SELECTED_SCENES ? request.selectedSceneIds : null,
    extView: request.extView ?? null
  }
}

function overlap(a: WindowBounds, b: WindowBounds): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

function same(a: WindowBounds, b: WindowBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * Where a recorded window opens now. The display it was on is used when it is
 * still there; otherwise the one it overlaps most, otherwise the fallback (the
 * main window's display). The window is then kept inside that work area, which
 * is the rule `clampWindowToDisplay` applies to every open window.
 */
export function placePaneWindow(placement: PaneWindowPlacement, workAreas: WindowBounds[], fallback: WindowBounds,
  minimum = { width: 360, height: 400 }): { bounds: WindowBounds; maximized: boolean } {
  const saved = placement.bounds
  const savedArea = placement.workArea
  const recorded = savedArea ? workAreas.find((area) => same(area, savedArea)) : undefined
  const overlapping = [...workAreas].sort((a, b) => overlap(saved, b) - overlap(saved, a))[0]
  const area = recorded ?? (overlapping && overlap(saved, overlapping) > 0 ? overlapping : fallback)
  const width = Math.min(Math.max(saved.width, Math.min(minimum.width, area.width)), area.width)
  const height = Math.min(Math.max(saved.height, Math.min(minimum.height, area.height)), area.height)
  const x = Math.max(area.x, Math.min(saved.x, area.x + area.width - width))
  const y = Math.max(area.y, Math.min(saved.y, area.y + area.height - height))
  return { bounds: { x, y, width, height }, maximized: placement.maximized }
}
