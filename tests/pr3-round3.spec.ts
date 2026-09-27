import { acceptedResultFromTicket } from './review-fixture.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ArtifactId,
  OperationId,
  SessionId,
  SnapshotId,
  TaskId,
  WorkOrderId,
  type FusionEvent,
  type ToolEvidence,
  type WorkOrder,
  type WorkerReport,
} from '../src/contracts.js'
import { digestOf, sha256Hex } from '../src/digest.js'
import { STORE_MIGRATION_REQUIRED, USAGE_LEDGER_REQUIRED, WORK_ORDER_CONFLICT } from '../src/errors.js'
import { evaluateReport } from '../src/evidence/gate.js'
import { assertPlannedCheck, memoryVerificationRegistry } from '../src/evidence/receipts.js'
import { persistReviewRequest } from '../src/review/dispatch.js'
import { captureTicket, resultFromCapturedTicket, reviewRequestedEvent } from '../src/review/ticket.js'
import { reduceAll } from '../src/task/reducer.js'
import { FileFusionStore, requireStorageProjectionVersion } from '../src/task/store.js'
import { ingestDurable, known, newLedger, projectLedger, restoreLedger } from '../src/usage/ledger.js'
import { mergeUsageObservations, normalizeUsage, observationFromNormalized } from '../src/usage/normalize.js'
import { quoteLedger } from '../src/usage/pricing.js'
import { expectCode } from './helpers.js'
import { mainTestPlan, passingReceipt, plannedOptions, withFrozenPlan } from './planned.js'

function hash(value: string) {
  return sha256Hex(value)
}
function artifact(id: string) {
  return { id: ArtifactId(id), digest: hash(id), ownerTaskId: TaskId('task'), mediaType: 'text/plain', bytes: 1 }
}
function order(id = 'work', revision = 1): WorkOrder {
  return {
    schemaVersion: 1,
    taskId: TaskId('task'),
    id: WorkOrderId(id),
    operationId: OperationId('wo-op'),
    revision,
    goal: 'main project tests',
    constraints: [],
    acceptance: [{ id: 'tests', description: 'suite', verificationKind: 'test', verifierId: 'pytest', mandatory: true }],
    allowedPaths: ['/workspace/src'],
    forbiddenActions: [],
    baseSnapshot: SnapshotId('S1'),
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
function report(name = 'A', snapshot = 'S2', work = 'work'): WorkerReport {
  return {
    schemaVersion: 1,
    workOrderId: WorkOrderId(work),
    revision: 1,
    status: 'completed',
    summary: name,
    snapshot: SnapshotId(snapshot),
    changeManifest: artifact(`manifest-${name}`),
    coverage: [{ criterionId: 'tests', state: 'satisfied', evidenceIds: [ArtifactId('out')], explanation: 'passed' }],
    verification: [],
    unresolved: [],
    questions: [],
  }
}
function evidence(overrides: Partial<ToolEvidence> = {}): ToolEvidence {
  return {
    schemaVersion: 1,
    taskId: TaskId('task'),
    operationId: OperationId('check'),
    actor: SessionId('worker'),
    nativeToolCallId: 'call',
    argvDigest: hash('python -m pytest'),
    cwdDigest: hash('/workspace'),
    inputSnapshot: SnapshotId('S2'),
    outputSnapshot: SnapshotId('S2'),
    exitCode: 0,
    startedAt: '2026-09-21T00:00:00Z',
    endedAt: '2026-09-21T00:00:01Z',
    stdout: artifact('out'),
    stderr: artifact('err'),
    state: 'completed',
    ...overrides,
  }
}
function event<T extends FusionEvent['type']>(
  type: T,
  seq: number,
  payload: Extract<FusionEvent, { type: T }>['payload'],
): Extract<FusionEvent, { type: T }> {
  return {
    schemaVersion: 1,
    id: `e${seq}`,
    taskId: TaskId('task'),
    seq,
    revision: 1,
    type,
    createdAt: '2026-09-21T00:00:00Z',
    causeId: 'r3',
    payload,
  } as Extract<FusionEvent, { type: T }>
}
function start(work = order()): FusionEvent[] {
  return [
    event('task/created', 1, { parent: SessionId('parent'), selection: { kind: 'profile', profileId: 'fusion-auto' } }),
    event('intent/chosen', 2, { intent: 'DELEGATE' }),
    event('work-order/prepared', 3, { order: work, reservedChild: SessionId('worker') }),
    event('child/accepted', 4, { operationId: OperationId('wo-op'), child: SessionId('worker'), messageId: 'm1' }),
  ]
}
function submitValidate(name = 'A', snapshot = 'S2', work = 'work'): FusionEvent[] {
  return [
    event('report/submitted', 5, { operationId: OperationId('wo-op'), report: report(name, snapshot, work) }),
    event('report/validated', 6, { operationId: OperationId('wo-op'), report: report(name, snapshot, work) }),
  ]
}

describe('R3-A review subject stays captured', () => {
  it('A result cannot rebind onto B from latest TaskState', () => {
    const prefixA = [...start(), ...submitValidate('A', 'S2')]
    const requestedA = reviewRequestedEvent(reduceAll(prefixA), 7, { ticketId: 't-a', requestId: 'req-A' })
    const ticketA = captureTicket(requestedA.payload.ticket)
    const afterA = reduceAll([...prefixA, requestedA])
    const afterB = reduceAll([
      ...prefixA,
      requestedA,
      event('report/submitted', 8, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
      event('report/validated', 9, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
      reviewRequestedEvent(reduceAll([
        ...prefixA,
        requestedA,
        event('report/submitted', 8, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
        event('report/validated', 9, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
      ]), 10, { ticketId: 't-b', requestId: 'req-B' }),
    ])
    expect(afterB.activeReviewTicket?.requestId).toBe('req-B')
    const lateA = resultFromCapturedTicket(ticketA, {
      requestId: 'req-A',
      terminalEvidenceRef: 'term:req-A',
      classification: {
        reviewStatus: 'complete',
        decision: 'approve',
        protocolComplete: true,
        fallbackUsed: false,
        fallbackRequired: false,
        termination: 'success',
        reasons: [],
      },
    }, { eventId: 'late-a', seq: afterB.seq + 1, createdAt: '2026-09-21T00:00:00Z' })
    expect(lateA.payload.binding?.requestId).toBe('req-A')
    const afterLate = reduceAll([
      ...prefixA,
      requestedA,
      event('report/submitted', 8, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
      event('report/validated', 9, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
      reviewRequestedEvent(reduceAll([
        ...prefixA,
        requestedA,
        event('report/submitted', 8, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
        event('report/validated', 9, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
      ]), 10, { ticketId: 't-b', requestId: 'req-B' }),
      { ...lateA, seq: 11 },
    ])
    expect(afterLate.phase).not.toBe('COMPLETED')
    expect(afterLate.ignoredReviewResults.some(item => item.requestId === 'req-A')).toBe(true)
    expect(() => reduceAll([
      ...prefixA,
      requestedA,
      event('report/submitted', 8, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
      event('report/validated', 9, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
      reviewRequestedEvent(reduceAll([
        ...prefixA,
        requestedA,
        event('report/submitted', 8, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
        event('report/validated', 9, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
      ]), 10, { ticketId: 't-b', requestId: 'req-B' }),
      { ...lateA, seq: 11 },
      event('task/completed', 12, { snapshot: SnapshotId('S3'), verification: 'verified' }),
    ])).toThrow()
    expect(afterA.activeReviewTicket?.requestId).toBe('req-A')
  })

  it('new work-order work-2 cannot complete from work accept', () => {
    const prefix = [...start(), ...submitValidate()]
    const requested = reviewRequestedEvent(reduceAll(prefix), 7, { ticketId: 't-a', requestId: 'req-A' })
    const accepted = acceptedResultFromTicket(requested.payload.ticket, 8, { terminalEvidenceRef: 'term:req-A' })
    const afterAccept = reduceAll([...prefix, requested, accepted])
    expect(afterAccept.acceptedReview?.ticket.subject.workOrderId).toBe('work')
    const switched = reduceAll([
      ...prefix,
      requested,
      accepted,
      event('work-order/prepared', 9, { order: order('work-2'), reservedChild: SessionId('worker-2') }),
    ])
    expect(switched.currentWorkOrder?.id).toBe('work-2')
    expect(switched.acceptedReview).toBeUndefined()
    expect(switched.candidateReport).toBeUndefined()
    const lateValidate = reduceAll([
      ...prefix,
      requested,
      accepted,
      event('work-order/prepared', 9, { order: order('work-2'), reservedChild: SessionId('worker-2') }),
      event('report/validated', 10, { operationId: OperationId('wo-op'), report: report('A', 'S2', 'work') }),
    ])
    expect(lateValidate.staleValidations.length).toBeGreaterThan(0)
    expect(lateValidate.candidateReport).toBeUndefined()
    expect(() => reduceAll([
      ...prefix,
      requested,
      accepted,
      event('work-order/prepared', 9, { order: order('work-2'), reservedChild: SessionId('worker-2') }),
      event('report/validated', 10, { operationId: OperationId('wo-op'), report: report('A', 'S2', 'work') }),
      event('task/completed', 11, { snapshot: SnapshotId('S2'), verification: 'verified' }),
    ])).toThrow()
  })

  it('late A validation does not displace candidate B', () => {
    const submittedB = reduceAll([
      ...start(),
      event('report/submitted', 5, { operationId: OperationId('wo-op'), report: report('A', 'S2') }),
      event('report/validated', 6, { operationId: OperationId('wo-op'), report: report('A', 'S2') }),
      event('report/submitted', 7, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
    ])
    expect(submittedB.candidateReport?.summary).toBe('B')
    const lateA = reduceAll([
      ...start(),
      event('report/submitted', 5, { operationId: OperationId('wo-op'), report: report('A', 'S2') }),
      event('report/validated', 6, { operationId: OperationId('wo-op'), report: report('A', 'S2') }),
      event('report/submitted', 7, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
      event('report/validated', 8, { operationId: OperationId('wo-op'), report: report('A', 'S2') }),
    ])
    expect(lateA.candidateReport?.summary).toBe('B')
    expect(lateA.validatedReport?.summary).toBeUndefined()
    expect(lateA.validatedReceipt).toBeUndefined()
    expect(lateA.staleValidations.at(-1)?.reason).toBe('stale-validation')
    expect(lateA.phase).not.toBe('REVIEWING')
  })

  it('normal submitted→validated→requested→completed still succeeds', () => {
    const prefix = [...start(), ...submitValidate()]
    const requested = reviewRequestedEvent(reduceAll(prefix), 7, { ticketId: 't-ok', requestId: 'req-ok' })
    const accepted = acceptedResultFromTicket(requested.payload.ticket, 8, { terminalEvidenceRef: 'term:req-ok' })
    const state = reduceAll([
      ...prefix,
      requested,
      accepted,
      event('task/completed', 9, { snapshot: SnapshotId('S2'), verification: 'verified' }),
    ])
    expect(state.phase).toBe('COMPLETED')
    expect(state.acceptedReview?.ticket.requestId).toBe('req-ok')
  })

  it('same work-order identity with a different digest conflicts', () => {
    const first = order('work')
    expect(() => reduceAll([
      ...start(first),
      event('work-order/prepared', 5, { order: { ...first, goal: 'changed' }, reservedChild: SessionId('worker') }),
    ])).toThrowError(expect.objectContaining({ code: WORK_ORDER_CONFLICT }))
  })

  it('persists the captured ticket in the outbox before send', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmf-r3-outbox-'))
    try {
      const db = new FileFusionStore(dir)
      const prefix = [...start(), ...submitValidate()]
      db.create(prefix[0] as Extract<FusionEvent, { type: 'task/created' }>)
      db.append(TaskId('task'), 1, prefix.slice(1))
      const ticket = persistReviewRequest(db, TaskId('task'), { ticketId: 't-out', requestId: 'req-out' }, 'payload:req-out')
      const reloaded = new FileFusionStore(dir)
      expect(reloaded.load(TaskId('task'))?.activeReviewTicket?.requestId).toBe('req-out')
      expect(reloaded.outbox(TaskId('task'))[0]?.ticket?.requestId).toBe(ticket.requestId)
      expect(reloaded.outbox(TaskId('task'))[0]?.payloadRef).toBe('payload:req-out')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('R3-B explicit ledger is the only accumulator', () => {
  const key = { provider: 'p', model: 'm', requestId: 'r', attemptId: 'a', contractDigest: 'c' }
  const rates = { input: '1', output: '5' }

  it('JSON save/reload/replay 100+200 stays 300', () => {
    let ledger = newLedger(key)
    ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ outputTokens: 100 }), key, { source: 'partial', sequence: 1, cumulative: false, observationId: 'd1' }))
    ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ outputTokens: 200 }), key, { source: 'partial', sequence: 2, cumulative: false, observationId: 'd2' }))
    const restored = restoreLedger(JSON.parse(JSON.stringify(ledger)))
    const again = ingestDurable(restored, observationFromNormalized(normalizeUsage({ outputTokens: 100 }), key, { source: 'partial', sequence: 1, cumulative: false, observationId: 'd1' }))
    expect(projectLedger(again).bill?.output).toEqual(known(300))
    expect(quoteLedger(again, rates).totalUsd).toBeNull()
    expect(quoteLedger(again, rates).status).toBe('provisional')
  })

  it('final zero replaces earlier usage and can complete', () => {
    let ledger = newLedger(key)
    ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ outputTokens: 100 }), key, { source: 'partial', sequence: 1, observationId: 'p1' }))
    ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, inputIncludesCacheRead: false }), key, { source: 'final', sequence: 2, observationId: 'f0' }))
    const quote = quoteLedger(ledger, rates)
    expect(quote.authority).toBe('final')
    expect(quote.status).toBe('complete')
    expect(quote.totalUsd).toBe('0')
  })

  it('final unknown cannot borrow a partial known count', () => {
    let ledger = newLedger(key)
    ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ outputTokens: 100 }), key, { source: 'partial', sequence: 1, observationId: 'p1' }))
    ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ outputTokens: null }), key, { source: 'final', sequence: 2, observationId: 'fu' }))
    const quote = quoteLedger(ledger, rates)
    expect(quote.authority).toBe('final')
    expect(quote.status).toBe('incomplete')
    expect(quote.totalUsd).toBeNull()
  })

  it('mutating the input observation does not change the persisted ledger', () => {
    const observation = observationFromNormalized(normalizeUsage({ outputTokens: 100 }), key, { source: 'final', sequence: 1, observationId: 'f1' })
    const ledger = ingestDurable(newLedger(key), observation)
    ;(observation.bill.output as { tokens?: number }).tokens = 900
    expect(projectLedger(ledger).bill?.output).toEqual(known(100))
  })

  it('two provider requests never merge', () => {
    const other = { ...key, requestId: 'other' }
    expect(() => ingestDurable(
      ingestDurable(newLedger(key), observationFromNormalized(normalizeUsage({ outputTokens: 100 }), key, { source: 'partial', sequence: 1, observationId: 'a' })),
      observationFromNormalized(normalizeUsage({ outputTokens: 100 }), other, { source: 'partial', sequence: 1, observationId: 'b' }),
    )).toThrow()
  })

  it('retired merge wrapper cannot invent a complete ranking total', () => {
    expectCode(() => mergeUsageObservations(normalizeUsage({ outputTokens: 100 }), normalizeUsage({ outputTokens: 200 })), USAGE_LEDGER_REQUIRED)
  })

  it('restore rejects a projection that lacks history', () => {
    expect(() => restoreLedger({ schemaVersion: 1, output: 300 })).toThrow()
  })
})

describe('R3-C frozen CheckPlan is the verification scope', () => {
  it('a plan id without a work-order-frozen digest cannot authorize a check', () => {
    const check = evidence()
    const plan = mainTestPlan(order(), check)
    const unfrozen = { ...order(), acceptance: order().acceptance.map(c => ({ ...c, planId: plan.id })) }
    expect(evaluateReport(unfrozen, report(), [check], SnapshotId('S2'), plannedOptions(plan, [passingReceipt(plan, check)])).verification)
      .toBe('unverified')
  })

  it('reading a receipt cannot change the registered test outcome', () => {
    const check = evidence()
    const plan = mainTestPlan(order(), check)
    const registry = memoryVerificationRegistry([plan], [passingReceipt(plan, check, { executed: 1, passed: 0, failed: 1 })])
    const copy = registry.getReceipt('out')!
    copy.counts = { executed: 1, passed: 1, failed: 0 }
    expect(evaluateReport(withFrozenPlan(order(), plan), report(), [check], SnapshotId('S2'), { registry }).verification)
      .toBe('unverified')
  })

  it('main-project plan rejects /, src, demo, and unrelated cwd', () => {
    const check = evidence({ cwdDigest: hash('/workspace') })
    const plan = mainTestPlan(order(), check)
    const frozen = withFrozenPlan(order(), plan)
    const options = plannedOptions(plan, [passingReceipt(plan, check)])
    expect(evaluateReport(frozen, report(), [check], SnapshotId('S2'), options).verification).toBe('verified')
    for (const cwd of ['/', '/workspace/src', '/workspace/examples/demo', '/unrelated', 'C:\\unrelated']) {
      const wrong = evidence({ cwdDigest: hash(cwd) })
      expect(evaluateReport(frozen, report(), [wrong], SnapshotId('S2'), plannedOptions(plan, [passingReceipt(plan, wrong)])).verification)
        .not.toBe('verified')
    }
  })

  it('package cwd can pass only that exact directory', () => {
    const pkg = evidence({ cwdDigest: hash('/workspace/src') })
    const plan = mainTestPlan(order(), pkg)
    const frozen = withFrozenPlan(order(), plan)
    expect(evaluateReport(frozen, report(), [pkg], SnapshotId('S2'), plannedOptions(plan, [passingReceipt(plan, pkg)])).verification)
      .toBe('verified')
    const root = evidence({ cwdDigest: hash('/workspace') })
    expect(evaluateReport(frozen, report(), [root], SnapshotId('S2'), plannedOptions(plan, [passingReceipt(plan, root)])).verification)
      .not.toBe('verified')
  })

  it('relative allowedPaths and missing plan cannot skip cwd', () => {
    const check = evidence({ cwdDigest: hash('/unrelated-project') })
    expect(evaluateReport({ ...order(), allowedPaths: ['src'] }, report(), [check], SnapshotId('S2')).verification)
      .not.toBe('verified')
    expect(evaluateReport({ ...order(), allowedPaths: ['C:\\work\\repo\\src'] }, report(), [check], SnapshotId('S2')).verification)
      .not.toBe('verified')
  })

  it('zero tests, other work order, and wrong snapshot are rejected', () => {
    const check = evidence()
    const plan = mainTestPlan(order(), check)
    expect(() => assertPlannedCheck(withFrozenPlan(order(), plan), 'tests', plan, passingReceipt(plan, check, { executed: 0, passed: 0, failed: 0 }), SnapshotId('S2')))
      .toThrow(/TEST_SUITE_NOT_PASSED/)
    expect(() => assertPlannedCheck(order('other'), 'tests', plan, passingReceipt(plan, check), SnapshotId('S2')))
      .toThrow(/PLAN_SCOPE_MISMATCH/)
    expect(() => assertPlannedCheck(order(), 'tests', plan, passingReceipt(plan, check), SnapshotId('S9')))
      .toThrow(/PLAN_SNAPSHOT_MISMATCH/)
  })
})

describe('R3-D store projection policy', () => {
  it('rejects partially upgraded control before execution, without silently resuming', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmf-r3-partial-store-'))
    try {
      const db = new FileFusionStore(dir)
      db.create(event('task/created', 1, { parent: SessionId('parent'), selection: { kind: 'profile', profileId: 'fusion-auto' } }))
      const path = join(dir, 'tasks', 'task', 'snapshot.json')
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      raw.persisted.state.control = { mode: 'paused' }
      raw.checksum = digestOf({ persisted: raw.persisted, artifacts: raw.artifacts })
      db.io.writeFileSync(path, JSON.stringify(raw))
      expectCode(() => new FileFusionStore(dir).load(TaskId('task')), STORE_MIGRATION_REQUIRED)
      expect(JSON.parse(readFileSync(path, 'utf8')).persisted.state.control.mode).toBe('paused')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a checksum-valid legacy snapshot before caching', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmf-r3-store-'))
    try {
      const db = new FileFusionStore(dir)
      db.create(event('task/created', 1, { parent: SessionId('parent'), selection: { kind: 'profile', profileId: 'fusion-auto' } }))
      const path = join(dir, 'tasks', 'task', 'snapshot.json')
      const current = JSON.parse(readFileSync(path, 'utf8')) as { persisted: unknown; artifacts: unknown }
      const legacy = {
        checksum: digestOf({ persisted: current.persisted, artifacts: current.artifacts }),
        persisted: current.persisted,
        artifacts: current.artifacts,
      }
      requireStorageProjectionVersion({ projectionVersion: 2 })
      expectCode(() => requireStorageProjectionVersion(legacy), STORE_MIGRATION_REQUIRED)
      const { writeFileSync } = db.io
      writeFileSync(path, `${JSON.stringify(legacy)}\n`)
      expectCode(() => new FileFusionStore(dir).load(TaskId('task')), STORE_MIGRATION_REQUIRED)
      expectCode(() => new FileFusionStore(dir).append(TaskId('task'), 1, []), STORE_MIGRATION_REQUIRED)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
