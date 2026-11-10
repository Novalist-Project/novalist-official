import type { AnnotationChange, WritingAnnotations } from '../views/editor/writingTypes'

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameValue(value, right[index]))
  }
  const entries = Object.entries(left).filter(([, value]) => value !== undefined)
  const other = new Map(Object.entries(right).filter(([, value]) => value !== undefined))
  return entries.length === other.size && entries.every(([key, value]) => other.has(key) && sameValue(value, other.get(key)))
}

function mergeRecords<T extends { id: string }>(current: readonly T[], before: readonly T[], after: readonly T[]): T[] {
  const previous = new Map(before.map(record => [record.id, record]))
  const desired = new Map(after.map(record => [record.id, record]))
  const actual = new Map(current.map(record => [record.id, record]))
  if (previous.size !== before.length || desired.size !== after.length || actual.size !== current.length) throw new Error('Duplicate shared annotation identity.')
  const changed = new Set([...previous.keys(), ...desired.keys()].filter(id => !sameValue(previous.get(id), desired.get(id))))
  for (const id of changed) {
    if (!sameValue(actual.get(id), previous.get(id))) throw new Error('Shared annotation revision conflict.')
  }
  const result = current.flatMap(record => {
    if (!changed.has(record.id)) return [record]
    const replacement = desired.get(record.id)
    return replacement ? [replacement] : []
  })
  for (const record of after) if (changed.has(record.id) && !actual.has(record.id)) result.push(record)
  return structuredClone(result)
}

export function mergeSharedAnnotations(current: WritingAnnotations, change: AnnotationChange): WritingAnnotations {
  return { comments: mergeRecords(current.comments, change.before.comments, change.after.comments),
    footnotes: mergeRecords(current.footnotes, change.before.footnotes, change.after.footnotes) }
}
