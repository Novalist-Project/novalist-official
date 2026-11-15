import { diffArrays } from 'diff'

export type MergeChoice = 'local' | 'server'

export interface ProseMergeConflict {
  id: string
  local: string
  server: string
}

interface Hunk {
  start: number
  end: number
  tokens: string[]
}

interface Group {
  start: number
  end: number
  local: Hunk[]
  server: Hunk[]
}

export interface ProseMergePlan {
  // Local changes that touch nothing the server changed; Yjs merges them from the saved base state.
  localOnly: string
  // The whole document as it should read once every choice is applied.
  desired: string
  conflicts: ProseMergeConflict[]
}

const blockEnd = /(?<=<\/(?:p|h[1-6]|li|ul|ol|blockquote|pre|div|figure|table)>|<hr\b[^>]*>|\n)/i

export function proseBlocks(content: string, plainText: boolean): string[] {
  return content.split(plainText ? /(?<=\n)/ : blockEnd).filter(token => token.length > 0)
}

// Plans a three-way merge by paragraph. A paragraph only one side changed merges on its own; a paragraph
// both sides changed differently is a conflict, resolved by `choices` and otherwise left as the server has it.
export function planProseMerge(base: string, local: string, server: string, plainText: boolean,
  choices: Readonly<Record<string, MergeChoice>> | null): ProseMergePlan {
  const origin = proseBlocks(base, plainText)
  const groups = group(hunks(origin, proseBlocks(local, plainText)), hunks(origin, proseBlocks(server, plainText)))
  const conflicts: ProseMergeConflict[] = []
  const localOnly: string[] = []
  const desired: string[] = []
  let position = 0
  for (const entry of groups) {
    const between = origin.slice(position, entry.start)
    localOnly.push(...between)
    desired.push(...between)
    const original = origin.slice(entry.start, entry.end)
    const mine = apply(origin, entry.start, entry.end, entry.local)
    const theirs = apply(origin, entry.start, entry.end, entry.server)
    position = entry.end
    if (!entry.server.length) { localOnly.push(...mine); desired.push(...mine); continue }
    localOnly.push(...original)
    if (!entry.local.length || mine.join('') === theirs.join('')) { desired.push(...theirs); continue }
    const id = entry.local.map(hunk => `${hunk.start}-${hunk.end}`).join(',')
    conflicts.push({ id, local: mine.join(''), server: theirs.join('') })
    desired.push(...(choices?.[id] === 'local' ? mine : theirs))
  }
  const rest = origin.slice(position)
  localOnly.push(...rest)
  desired.push(...rest)
  return { localOnly: localOnly.join(''), desired: desired.join(''), conflicts }
}

function hunks(base: string[], next: string[]): Hunk[] {
  const result: Hunk[] = []
  let index = 0
  let current: Hunk | null = null
  for (const part of diffArrays(base, next)) {
    if (!part.added && !part.removed) {
      if (current) result.push(current)
      current = null
      index += part.count ?? part.value.length
      continue
    }
    current ??= { start: index, end: index, tokens: [] }
    if (part.removed) {
      index += part.count ?? part.value.length
      current.end = index
    } else current.tokens.push(...part.value)
  }
  if (current) result.push(current)
  return result
}

function overlaps(left: Hunk, right: Hunk): boolean {
  if (left.start < right.end && right.start < left.end) return true
  return left.start === right.start && (left.start === left.end || right.start === right.end)
}

// Joins hunks from both sides into regions; a region with hunks from both sides is a potential conflict.
function group(local: Hunk[], server: Hunk[]): Group[] {
  const all = [...local.map(hunk => ({ hunk, local: true })), ...server.map(hunk => ({ hunk, local: false }))]
    .sort((left, right) => left.hunk.start - right.hunk.start || left.hunk.end - right.hunk.end)
  const result: Group[] = []
  for (const { hunk, local: mine } of all) {
    const last = result.at(-1)
    const joins = last && [...(mine ? last.server : last.local)].some(other => overlaps(hunk, other))
    if (last && (joins || hunk.start < last.end)) {
      last.end = Math.max(last.end, hunk.end)
      ;(mine ? last.local : last.server).push(hunk)
    } else result.push({ start: hunk.start, end: hunk.end, local: mine ? [hunk] : [], server: mine ? [] : [hunk] })
  }
  return result
}

function apply(base: string[], start: number, end: number, changes: Hunk[]): string[] {
  const output: string[] = []
  let position = start
  for (const change of changes) {
    output.push(...base.slice(position, change.start), ...change.tokens)
    position = change.end
  }
  output.push(...base.slice(position, end))
  return output
}
