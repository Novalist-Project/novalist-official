import { createHash } from 'node:crypto'

function signature(value: string): { sha256: string; characters: number; utf8Bytes: number } {
  return { sha256: createHash('sha256').update(value).digest('hex'), characters: value.length, utf8Bytes: Buffer.byteLength(value) }
}

function contentEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(contentEvidence)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === 'attributes' && item && typeof item === 'object' && !Array.isArray(item)) return ['attributesEvidence', signature(JSON.stringify(item))]
    if (['html', 'text', 'plainText', 'insert', 'authored', 'serialized'].includes(key)) {
      if (typeof item === 'string') return [key + 'Evidence', signature(item)]
      if (Array.isArray(item) && item.every(entry => typeof entry === 'string')) return [key + 'Evidence', item.map(signature)]
    }
    return [key, contentEvidence(item)]
  }))
}

export function writingDiagnosticEvidence(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).flatMap(([key, value]) => {
    if (key === 'serialized') return Object.entries(contentEvidence({ serialized: value }) as Record<string, unknown>)
    return [[key, ['before', 'first', 'second', 'samples', 'result', 'after', 'undone', 'redone', 'output', 'publications'].includes(key) ? contentEvidence(value) : value]]
  }))
}
