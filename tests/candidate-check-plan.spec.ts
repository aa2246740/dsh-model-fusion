import { describe, expect, it } from 'vitest'
import { ArtifactId, OperationId, SessionId, SnapshotId } from '../src/contracts.js'
import type { ToolEvidence } from '../src/contracts.js'
import { digestOf } from '../src/digest.js'
import { assertPlannedCheck } from '../src/evidence/receipts.js'
import { order, TASK } from './helpers.js'
import { mainTestPlan, passingReceipt, withFrozenPlan } from './planned.js'

function evidence(snapshot = SnapshotId('candidate')): ToolEvidence {
  const artifact = (text: string) => ({ id: ArtifactId(text), digest: digestOf(text), ownerTaskId: TASK, mediaType: 'text/plain', bytes: text.length })
  return { schemaVersion: 1, taskId: TASK, operationId: OperationId('native-check'), actor: SessionId('lead'),
    nativeToolCallId: 'native-call', argvDigest: digestOf('frozen command'), cwdDigest: digestOf('/workspace'),
    inputSnapshot: snapshot, outputSnapshot: snapshot, exitCode: 0, startedAt: '2026-09-21T00:00:00Z',
    endedAt: '2026-09-21T00:00:01Z', stdout: artifact('stdout'), stderr: artifact('stderr'), state: 'completed' }
}

describe('verifier frozen before the Worker changes files', () => {
  it('keeps the same plan digest while requiring an exact candidate invocation receipt', () => {
    const work = order()
    const check = evidence()
    const plan = { ...mainTestPlan(work, check, { version: 2, snapshot: work.baseSnapshot }), snapshotBinding: 'candidate' as const }
    const frozen = withFrozenPlan(work, plan)
    const receipt = passingReceipt(plan, check)
    expect(() => assertPlannedCheck(frozen, 't1', plan, receipt, check.inputSnapshot)).not.toThrow()
    expect(() => assertPlannedCheck(frozen, 't1', plan, receipt, SnapshotId('newer-candidate'))).toThrow('CHECK_SNAPSHOT_MISMATCH')
    const nextCheck = evidence(SnapshotId('newer-candidate'))
    expect(() => assertPlannedCheck(frozen, 't1', plan, passingReceipt(plan, nextCheck), nextCheck.inputSnapshot)).not.toThrow()
    expect(frozen.acceptance[0].planDigest).toBe(digestOf(plan))
  })

  it('rejects changed definitions, unrelated base snapshots and version-one late binding', () => {
    const work = order(); const check = evidence()
    const plan = { ...mainTestPlan(work, check, { version: 2, snapshot: work.baseSnapshot }), snapshotBinding: 'candidate' as const }
    const frozen = withFrozenPlan(work, plan)
    const changed = { ...plan, argvDigest: digestOf('different command') }
    expect(() => assertPlannedCheck(frozen, 't1', changed, passingReceipt(changed, check), check.inputSnapshot)).toThrow('PLAN_NOT_FROZEN')
    expect(() => assertPlannedCheck({ ...frozen, baseSnapshot: SnapshotId('unrelated') }, 't1', plan, passingReceipt(plan, check), check.inputSnapshot)).toThrow('PLAN_BASE_SNAPSHOT')
    const oldVersion = { ...plan, version: 1 }
    expect(() => assertPlannedCheck(withFrozenPlan(work, oldVersion), 't1', oldVersion, passingReceipt(oldVersion, check), check.inputSnapshot)).toThrow('UNSUPPORTED_SNAPSHOT_BINDING')
  })

  it('does not relax legacy exact snapshots or standalone frozen-plan checks', () => {
    const work = order(); const check = evidence()
    const plan = mainTestPlan(work, check)
    expect(() => assertPlannedCheck(withFrozenPlan(work, plan), 't1', plan, passingReceipt(plan, check), SnapshotId('different'))).toThrow('PLAN_SNAPSHOT')
    expect(() => assertPlannedCheck(work, 't1', plan, passingReceipt(plan, check), check.inputSnapshot)).toThrow('PLAN_NOT_FROZEN')
  })
})
