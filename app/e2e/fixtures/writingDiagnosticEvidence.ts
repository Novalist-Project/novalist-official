import { createHash } from 'node:crypto'

function signature(value: string): { sha256: string; characters: number; utf8Bytes: number } {
  return { sha256: createHash('sha256').update(value).digest('hex'), characters: value.length, utf8Bytes: Buffer.byteLength(value) }
}

export function writingDiagnosticEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(writingDiagnosticEvidence)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (['html', 'text', 'authored', 'serialized'].includes(key)) {
      if (typeof item === 'string') return [key + 'Evidence', signature(item)]
      if (Array.isArray(item) && item.every(entry => typeof entry === 'string')) return [key + 'Evidence', item.map(signature)]
    }
    return [key, writingDiagnosticEvidence(item)]
  }))
}
