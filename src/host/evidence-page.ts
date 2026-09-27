/** Lossless text decoding; binary artifacts stay available as explicit base64. */
export function evidenceText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { return undefined }
}

/** Offsets count UTF-16 code units of text, or characters of base64. */
export function evidencePage(bytes: Uint8Array, offset = 0, limit = 24_000) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Evidence offset must be a nonnegative safe integer')
  if (!Number.isSafeInteger(limit) || limit < 2 || limit > 24_000) throw new Error('Evidence limit must be an integer from 2 to 24000')
  const decoded = evidenceText(bytes)
  const encoding = decoded === undefined ? 'base64' : 'utf-8'
  const content = decoded ?? Buffer.from(bytes).toString('base64')
  if (offset > content.length) throw new Error('Evidence offset exceeds the artifact text length')
  const splitsPair = (at: number) => at > 0 && at < content.length
    && content.charCodeAt(at - 1) >= 0xd800 && content.charCodeAt(at - 1) <= 0xdbff
    && content.charCodeAt(at) >= 0xdc00 && content.charCodeAt(at) <= 0xdfff
  if (splitsPair(offset)) throw new Error('Evidence offset splits a Unicode character; use the returned nextOffset')
  let end = Math.min(content.length, offset + limit)
  if (splitsPair(end)) end--
  const truncated = end < content.length
  return { bytes: bytes.byteLength, encoding, offsetUnit: 'utf-16-code-units', offset, totalCharacters: content.length,
    text: content.slice(offset, end), truncated, nextOffset: truncated ? end : null }
}
