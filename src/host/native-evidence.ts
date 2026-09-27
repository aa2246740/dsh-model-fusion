import type { ArtifactRef, TaskId, ToolEvidence } from '../contracts.js'
import { digestOf } from '../digest.js'
import type { PlannedReceipt } from '../evidence/receipts.js'
import type { SqliteFusionStore } from '../task/sqlite-store.js'
import type { FrozenCheck } from './native-checks.js'

/** Coverage uses logical receipt IDs; ordinary evidence uses content digests. */
export function readNativeEvidence(store: SqliteFusionStore, taskId: TaskId, id: string): Uint8Array {
  if (!id.startsWith('receipt:')) return store.readArtifact(taskId, id)
  const match = /^receipt:(fusion-check-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(id)
  if (!match) throw new Error('Invalid native check receipt id')
  // Never search another task's documents, even when the caller knows its ID.
  const document = store.readDocument(`check-invocation:${taskId}:${match[1]}`)
  const record = document?.value as { check?: FrozenCheck; receipt?: PlannedReceipt; evidence?: ToolEvidence } | undefined
  const { check, receipt, evidence } = record ?? {}
  if (!check?.plan || !check.definition || !receipt?.evidence || !evidence
    || receipt.id !== id || check.plan.taskId !== taskId || evidence.taskId !== taskId
    || evidence.nativeToolCallId !== match[1] || evidence.operationId !== match[1]
    || receipt.planDigest !== digestOf(check.plan) || digestOf(receipt.evidence) !== digestOf(evidence)
    || evidence.argvDigest !== check.plan.argvDigest || evidence.cwdDigest !== check.plan.cwdDigest) {
    throw new Error('Native check receipt unavailable or invalid for this task')
  }
  const refs: ArtifactRef[] = [evidence.stdout, evidence.stderr]
  if (refs.some(ref => !ref || ref.ownerTaskId !== taskId || String(ref.id) !== ref.digest
    || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0)) throw new Error('Invalid check output ownership or reference')
  const contents = store.readArtifacts(taskId, refs.map(ref => ref.id))
  if (contents.some((bytes, index) => bytes.byteLength !== refs[index]!.bytes)) throw new Error('Invalid check output length')
  // Reading a failed or old check is allowed. Only the existing review gate can
  // decide whether it proves acceptance of the current candidate.
  return Buffer.from(JSON.stringify({ kind: 'check-receipt', check, receipt }))
}
