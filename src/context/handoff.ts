/**
 * Upper bound on recent conversation text carried into a Sidekick brief after compaction: about 10k tokens,
 * enough for the latest exchanges while leaving most of the Sidekick's context for the task itself.
 */
export const HANDOFF_CONTENT_BYTES = 40_000

/** Content bytes only: envelopes and independently retained task facts are extra. */
export function recentHandoffSuffix<T extends { readonly content: string }>(records: readonly T[]) {
  const lengths = records.map(record => Buffer.byteLength(record.content, 'utf8'))
  let first = records.length, remaining = HANDOFF_CONTENT_BYTES
  for (let index = records.length - 1; index >= 0; index--) {
    const bytes = lengths[index]!
    // Keep the newest whole record, even when it alone exceeds the allowance.
    // Stop at the first older non-fitting record; do not skip it to fill gaps.
    if (index !== records.length - 1 && bytes > remaining) break
    first = index
    remaining = Math.max(0, remaining - bytes)
  }
  return {
    policy: 'recent-whole-records-utf8-v1' as const,
    contentByteBudget: HANDOFF_CONTENT_BYTES,
    totalRecords: records.length,
    omittedRecords: first,
    totalContentBytes: lengths.reduce((sum, bytes) => sum + bytes, 0),
    retainedContentBytes: lengths.slice(first).reduce((sum, bytes) => sum + bytes, 0),
    records: records.slice(first),
  }
}
