import { describe, expect, it } from 'vitest'
import {
  ArtifactId,
  OperationId,
  SessionId,
  SnapshotId,
  TaskId,
  WorkOrderId,
  type ToolEvidence,
  type WorkOrder,
  type WorkerReport,
} from '../src/contracts.js'
import { evaluateReport } from '../src/evidence/gate.js'
import { USAGE_LEDGER_REQUIRED, USAGE_MERGE_CONFLICT } from '../src/errors.js'
import { ingestDurable, known, newLedger, projectLedger } from '../src/usage/ledger.js'
import { apiEquivalentUsd, mergeUsageObservations, normalizeUsage, observationFromNormalized, priceUsage } from '../src/usage/normalize.js'
import { mainTestPlan, passingReceipt, plannedOptions, withFrozenPlan } from './planned.js'
import { sha256Hex } from '../src/digest.js'
import { expectCode } from './helpers.js'

const S1 = SnapshotId('S1')
const S2 = SnapshotId('S2')
const TASK = TaskId('task')

function workOrder(): WorkOrder {
  return {
    schemaVersion: 1,
    taskId: TASK,
    id: WorkOrderId('work'),
    operationId: OperationId('wo-op'),
    revision: 1,
    goal: 'fix the bug',
    constraints: [],
    acceptance: [{ id: 'must-pass', description: 'hidden tests pass', verificationKind: 'test', mandatory: true }],
    allowedPaths: ['src'],
    forbiddenActions: [],
    baseSnapshot: S1,
    evidence: [],
    decisions: [],
    uncertainties: [],
    policy: {
      maxWorkerSteps: 40,
      maxReworkRounds: 2,
      maxCapabilityUpgrades: 1,
      maxTotalOutputTokens: 50_000,
      commandMaxSeconds: 30,
    },
  }
}

function artifact(id: string) {
  return {
    id: ArtifactId(id),
    digest: sha256Hex(id),
    ownerTaskId: TASK,
    mediaType: 'text/plain',
    bytes: 0,
  }
}

function report(coverage: WorkerReport['coverage']): WorkerReport {
  const ref = artifact('manifest')
  return {
    schemaVersion: 1,
    workOrderId: WorkOrderId('work'),
    revision: 1,
    status: 'completed',
    summary: 'done',
    snapshot: S2,
    changeManifest: ref,
    coverage,
    verification: [],
    unresolved: [],
    questions: [],
  }
}

function evidence(overrides: Partial<ToolEvidence> = {}): ToolEvidence {
  const ref = artifact('artifact')
  return {
    schemaVersion: 1,
    taskId: TASK,
    operationId: OperationId('op'),
    actor: SessionId('worker'),
    nativeToolCallId: 'call',
    argvDigest: sha256Hex('python -m pytest'),
    cwdDigest: sha256Hex('dir'),
    inputSnapshot: S2,
    outputSnapshot: S2,
    exitCode: 0,
    startedAt: '2026-09-20T00:00:00Z',
    endedAt: '2026-09-20T00:00:01Z',
    stdout: ref,
    stderr: ref,
    state: 'completed',
    ...overrides,
  }
}

const card = {
  digest: 'test-only',
  uncachedInputPerMillion: '1',
  cacheReadPerMillion: '0.1',
  cacheWritePerMillion: { default: '1.25' },
  outputPerMillion: '5',
}

describe('review counterexamples G1-G5', () => {
  it('G1 rejects a satisfied claim that cites a missing evidence id', () => {
    const verdict = evaluateReport(
      workOrder(),
      report([{ criterionId: 'must-pass', state: 'satisfied', evidenceIds: [ArtifactId('nonexistent')], explanation: 'ok' }]),
      [evidence()],
      S2,
    )
    expect(verdict.verification).toBe('unverified')
  })

  it('G2 rejects started evidence until a completed trusted check exists', () => {
    const verdict = evaluateReport(
      workOrder(),
      report([{ criterionId: 'must-pass', state: 'satisfied', evidenceIds: [ArtifactId('artifact')], explanation: 'ok' }]),
      [evidence({ state: 'started', exitCode: null, endedAt: null })],
      S2,
    )
    expect(verdict.verification).toBe('unverified')
  })

  it('G3 scores frozen work-order criteria, not an empty self-declared coverage list', () => {
    const verdict = evaluateReport(workOrder(), report([]), [evidence()], S2)
    expect(verdict.verification).not.toBe('verified')
    expect(verdict.reasons.some(reason => reason.includes('must-pass'))).toBe(true)
  })

  it('G4 rejects stale snapshot evidence for the current workspace', () => {
    const verdict = evaluateReport(
      workOrder(),
      report([{ criterionId: 'must-pass', state: 'satisfied', evidenceIds: [ArtifactId('artifact')], explanation: 'ok' }]),
      [evidence({ inputSnapshot: S1, outputSnapshot: S1 })],
      S2,
    )
    expect(verdict.verification).toBe('unverified')
  })

  it('G5 ignores unreferenced historical failures when current checks pass', () => {
    const current = evidence({
      operationId: OperationId('current'),
      stdout: artifact('current'),
      stderr: artifact('current-err'),
    })
    const historical = evidence({
      operationId: OperationId('old'),
      exitCode: 1,
      inputSnapshot: S1,
      outputSnapshot: S1,
      stdout: artifact('old'),
      stderr: artifact('old-err'),
    })
    const plan = mainTestPlan(workOrder(), current)
    const verdict = evaluateReport(
      withFrozenPlan(workOrder(), plan),
      report([{ criterionId: 'must-pass', state: 'satisfied', evidenceIds: [ArtifactId('current')], explanation: 'ok' }]),
      [historical, current],
      S2,
      plannedOptions(plan, [passingReceipt(plan, current)]),
    )
    expect(verdict.verification).toBe('verified')
    expect(verdict.reasons).toEqual([])
  })
})

describe('review counterexamples U1-U4', () => {
  it('U1 does not treat missing usage as a $0 total', () => {
    const priced = priceUsage(normalizeUsage({}), card)
    expect(apiEquivalentUsd(normalizeUsage({}), card)).toBeNull()
    expect(priced.status).toBe('unknown')
    expect(priced.totalUsd).toBeNull()
  })

  it('U2 keeps a partial observed cost from becoming the complete total', () => {
    const usage = normalizeUsage({ inputTokens: 1000 })
    const priced = priceUsage(usage, card)
    expect(apiEquivalentUsd(usage, card)).toBeNull()
    expect(priced.status).toBe('incomplete')
    expect(priced.observedUsd).toBe('0.001')
    expect(priced.totalUsd).toBeNull()
  })

  it('U3 prefers an authoritative later cumulative observation over a partial', () => {
    const key = { provider: 'p', model: 'm', requestId: 'r', attemptId: 'a', contractDigest: 'c' }
    let ledger = newLedger(key)
    ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ inputTokens: 1000, outputTokens: 100 }), key, { source: 'partial', sequence: 1, observationId: 'p1' }))
    ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ inputTokens: 1000, outputTokens: 10000 }), key, { source: 'final', sequence: 2, observationId: 'f2' }))
    expect(projectLedger(ledger).bill?.output).toEqual(known(10000))
  })

  it('U3 marks conflicting finals instead of silently keeping the smaller value', () => {
    const key = { provider: 'p', model: 'm', requestId: 'r', attemptId: 'a', contractDigest: 'c' }
    expectCode(
      () => {
        let ledger = newLedger(key)
        ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ outputTokens: 100 }), key, { source: 'final', sequence: 1, observationId: 'f1' }))
        return ingestDurable(ledger, observationFromNormalized(normalizeUsage({ outputTokens: 10000 }), key, { source: 'final', sequence: 2, observationId: 'f2' }))
      },
      USAGE_MERGE_CONFLICT,
    )
    expectCode(() => mergeUsageObservations(normalizeUsage({ outputTokens: 100 }), normalizeUsage({ outputTokens: 10000 })), USAGE_LEDGER_REQUIRED)
  })

  it('U4 prices separately billed reasoning at the output rate', () => {
    const usage = normalizeUsage({
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 1000,
      reasoningTokens: 7000,
      outputIncludesReasoning: false,
    })
    expect(usage.reasoningOutputSubset).toBeNull()
    expect(usage.reasoningSeparate).toBe(7000)
    expect(apiEquivalentUsd(usage, card)).toBe('0.04')
  })
})
