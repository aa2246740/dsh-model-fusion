import { createHash } from 'node:crypto'
import type { Digest } from './contracts.js'

export function sha256Hex(data: string | Uint8Array): Digest {
  return createHash('sha256').update(data).digest('hex') as Digest
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .filter(key => !key.startsWith('_'))
        .sort()
        .map(key => [key, sortKeys(record[key])]),
    )
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

export function digestOf(value: unknown): Digest {
  return sha256Hex(canonicalJson(value))
}
