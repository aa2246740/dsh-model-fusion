import { acceptedResultFromTicket } from './review-fixture.js'
import { describe, expect, it } from 'vitest'
import { evaluateReport } from '../src/evidence/gate.js'
import { resolveInvocation } from '../src/evidence/receipts.js'
import { classifyReview } from '../src/review/protocol.js'
import { reviewRequestedEvent } from '../src/review/ticket.js'
import { reduceAll } from '../src/task/reducer.js'
import { FileFusionStore } from '../src/task/store.js'
import {
  ingestDurable,
  ingestObservation,
  known,
  na,
  newLedger,
  projectLedger,
  type CanonicalBill,
  type UsageObservation,
} from '../src/usage/ledger.js'
import { normalizeUsage, observationFromNormalized, priceUsage } from '../src/usage/normalize.js'
import { quoteLedger } from '../src/usage/pricing.js'
import { mainTestPlan, passingReceipt, plannedOptions, withFrozenPlan } from './planned.js'
import { sha256Hex } from '../src/digest.js'
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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const card = {
  digest: 'fixture-NOT-market-price',
  uncachedInputPerMillion: '1',
  cacheReadPerMillion: '0.1',
  cacheWritePerMillion: { default: '1.25', '5m': '1.25', '1h': '2' },
  outputPerMillion: '5',
}

function hash(value: string) {
  return sha256Hex(value)
}

function artifact(id: string) {
  return { id: ArtifactId(id), digest: hash(id), ownerTaskId: TaskId('task'), mediaType: 'text/plain', bytes: 1 }
}

function order(): WorkOrder {
  return {
    schemaVersion: 1,
    taskId: TaskId('task'),
    id: WorkOrderId('work'),
    operationId: OperationId('wo-op'),
    revision: 1,
    goal: 'Validate the main project at /workspace, not the example package',
    constraints: [],
    acceptance: [{
      id: 'tests',
      description: 'Main workspace test suite passes',
      verificationKind: 'test',
      verifierId: 'pytest',
      mandatory: true,
    }],
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

function report(name = 'A', snapshot = 'S2'): WorkerReport {
  return {
    schemaVersion: 1,
    workOrderId: WorkOrderId('work'),
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
    causeId: 'test',
    payload,
  } as Extract<FusionEvent, { type: T }>
}

function start(): FusionEvent[] {
  return [
    event('task/created', 1, { parent: SessionId('parent'), selection: { kind: 'profile', profileId: 'fusion-auto' } }),
    event('intent/chosen', 2, { intent: 'DELEGATE' }),
    event('work-order/prepared', 3, { order: order(), reservedChild: SessionId('worker') }),
    event('child/accepted', 4, { operationId: OperationId('wo-op'), child: SessionId('worker'), messageId: 'm1' }),
  ]
}

function attempt(fn: () => unknown) {
  try {
    return { returned: fn() }
  } catch (error) {
    return { threw: (error as { code?: string; name?: string }).code ?? (error as Error).name, message: (error as Error).message }
  }
}

const raw = (extras: Parameters<typeof normalizeUsage>[0] = {}) => normalizeUsage({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  inputIncludesCacheRead: false,
  ...extras,
})
const meta = (
  source: 'partial' | 'final',
  sequence: number,
  cumulative = true,
  observationId = `o${sequence}`,
) => ({ requestId: 'req', source, sequence, cumulative, observationId })

describe('PR3 round-2 review binding and control gates', () => {
  it('S01 submitted is not validated and cannot complete', () => {
    const result = attempt(() => reduceAll([
      ...start(),
      event('report/submitted', 5, { operationId: OperationId('wo-op'), report: report() }),
      event('review/completed', 6, { decision: 'accept' }),
      event('task/completed', 7, { snapshot: SnapshotId('S2'), verification: 'verified' }),
    ]))
    expect(Boolean(result.threw) || (result.returned as { phase?: string })?.phase !== 'COMPLETED').toBe(true)
  })

  it('S02 review of A cannot approve B', () => {
    const result = attempt(() => reduceAll([
      ...start(),
      event('report/validated', 5, { operationId: OperationId('wo-op'), report: report('A', 'S2') }),
      event('report/validated', 6, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
      event('review/completed', 7, { decision: 'accept' }),
      event('task/completed', 8, { snapshot: SnapshotId('S3'), verification: 'verified' }),
    ]))
    expect(Boolean(result.threw) || (result.returned as { phase?: string })?.phase !== 'COMPLETED').toBe(true)
  })

  it('S03 submitted then validated enters REVIEWING', () => {
    const state = reduceAll([
      ...start(),
      event('report/submitted', 5, { operationId: OperationId('wo-op'), report: report() }),
      event('report/validated', 6, { operationId: OperationId('wo-op'), report: report() }),
    ])
    expect(state.phase).toBe('REVIEWING')
    expect(state.validatedReport).toBeDefined()
    expect(state.candidateReport).toBeDefined()
  })

  it('S04 pending approval survives a late accept', () => {
    const result = attempt(() => reduceAll([
      ...start(),
      event('report/validated', 5, { operationId: OperationId('wo-op'), report: report() }),
      event('approval/pending', 6, {
        approval: {
          id: 'ap-1',
          taskId: TaskId('task'),
          revision: 1,
          operationId: OperationId('approval-op'),
          argsDigest: hash('args'),
          snapshot: SnapshotId('S2'),
          permissionPolicyDigest: hash('policy'),
          state: 'pending',
        },
      }),
      event('review/completed', 7, { decision: 'accept' }),
      event('task/completed', 8, { snapshot: SnapshotId('S2'), verification: 'verified' }),
    ]))
    expect(result.threw).toBeTruthy()
  })

  it('S05 stop-requested survives a late accept', () => {
    const result = attempt(() => reduceAll([
      ...start(),
      event('report/validated', 5, { operationId: OperationId('wo-op'), report: report() }),
      event('task/stop-requested', 6, { intent: 'cancel' }),
      event('review/completed', 7, { decision: 'accept' }),
      event('task/completed', 8, { snapshot: SnapshotId('S2'), verification: 'verified' }),
    ]))
    expect(result.threw).toBeTruthy()
  })

  it('S06 accepted S2 cannot complete after S3', () => {
    const prefix = [
      ...start(),
      event('report/submitted', 5, { operationId: OperationId('wo-op'), report: report() }),
      event('report/validated', 6, { operationId: OperationId('wo-op'), report: report() }),
    ]
    const requested = reviewRequestedEvent(reduceAll(prefix), 7, { ticketId: 't-s2', requestId: 'req-s2' })
    const accepted = acceptedResultFromTicket(requested.payload.ticket, 8, { terminalEvidenceRef: 'term:req-s2' })
    const result = attempt(() => reduceAll([
      ...prefix,
      requested,
      accepted,
      event('checkpoint/committed', 9, {
        checkpoint: {
          schemaVersion: 1,
          epochId: 'epoch-2' as never,
          taskId: TaskId('task'),
          revision: 1,
          goal: 'fix bug',
          mandatoryConstraints: [],
          snapshot: SnapshotId('S3'),
          decisions: [],
          coverage: [],
          pendingApprovalIds: [],
          openQuestions: [],
          evidence: [],
          sourceSurfaceSeqs: [5],
          digest: hash('checkpoint-S3'),
        },
      }),
      event('task/completed', 10, { snapshot: SnapshotId('S2'), verification: 'verified' }),
    ]))
    expect(result.threw).toBeTruthy()
  })

  it('bound submitted→validated→requested→accepted→completed succeeds', () => {
    const prefix = [
      ...start(),
      event('report/submitted', 5, { operationId: OperationId('wo-op'), report: report() }),
      event('report/validated', 6, { operationId: OperationId('wo-op'), report: report() }),
    ]
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

  it('a late A ticket cannot approve B', () => {
    const first = [
      ...start(),
      event('report/submitted', 5, { operationId: OperationId('wo-op'), report: report('A', 'S2') }),
      event('report/validated', 6, { operationId: OperationId('wo-op'), report: report('A', 'S2') }),
    ]
    const requestedA = reviewRequestedEvent(reduceAll(first), 7, { ticketId: 't-a', requestId: 'req-a' })
    const acceptedA = acceptedResultFromTicket(requestedA.payload.ticket, 8, { terminalEvidenceRef: 'term:req-a' })
    const result = attempt(() => reduceAll([
      ...first,
      requestedA,
      event('report/submitted', 8, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
      event('report/validated', 9, { operationId: OperationId('wo-op'), report: report('B', 'S3') }),
      { ...acceptedA, seq: 10, id: 'late-a' },
      event('task/completed', 11, { snapshot: SnapshotId('S3'), verification: 'verified' }),
    ]))
    expect(result.threw).toBeTruthy()
  })

  it('same bound result is idempotent and a conflicting result fails', () => {
    const prefix = [
      ...start(),
      event('report/submitted', 5, { operationId: OperationId('wo-op'), report: report() }),
      event('report/validated', 6, { operationId: OperationId('wo-op'), report: report() }),
    ]
    const requested = reviewRequestedEvent(reduceAll(prefix), 7, { ticketId: 't-dup', requestId: 'req-dup' })
    const accepted = acceptedResultFromTicket(requested.payload.ticket, 8, { terminalEvidenceRef: 'term:req-dup' })
    const once = reduceAll([...prefix, requested, accepted])
    const again = reduceAll([...prefix, requested, accepted, { ...accepted, seq: 9, id: 'dup-accept' }])
    expect(again.acceptedReview?.resultDigest).toBe(once.acceptedReview?.resultDigest)
    expect(attempt(() => reduceAll([
      ...prefix,
      requested,
      accepted,
      acceptedResultFromTicket(requested.payload.ticket, 9, {
        eventId: 'conflict',
        terminalEvidenceRef: 'term:other',
        classification: {
          reviewStatus: 'complete',
          decision: 'rework',
          protocolComplete: true,
          fallbackUsed: false,
          fallbackRequired: false,
          termination: 'success',
          reasons: [],
        },
      }),
    ])).threw).toBeTruthy()
  })

  it('answering one of two approvals still blocks completion', () => {
    const prefix = [
      ...start(),
      event('report/submitted', 5, { operationId: OperationId('wo-op'), report: report() }),
      event('report/validated', 6, { operationId: OperationId('wo-op'), report: report() }),
    ]
    const requested = reviewRequestedEvent(reduceAll(prefix), 7, { ticketId: 't-ap', requestId: 'req-ap' })
    const accepted = acceptedResultFromTicket(requested.payload.ticket, 8, { terminalEvidenceRef: 'term:req-ap' })
    const pending = (id: string, seq: number): FusionEvent => event('approval/pending', seq, {
      approval: {
        id,
        taskId: TaskId('task'),
        revision: 1,
        operationId: OperationId(id),
        argsDigest: hash(id),
        snapshot: SnapshotId('S2'),
        permissionPolicyDigest: hash('policy'),
        state: 'pending',
      },
    })
    const result = attempt(() => reduceAll([
      ...prefix,
      requested,
      accepted,
      pending('ap-1', 9),
      pending('ap-2', 10),
      event('approval/answered', 11, { approvalId: 'ap-1', state: 'approved' }),
      event('task/completed', 12, { snapshot: SnapshotId('S2'), verification: 'verified' }),
    ]))
    expect(result.threw).toBeTruthy()
  })

  it('persists a ticket across store reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmf-ticket-'))
    try {
      const db = new FileFusionStore(dir)
      const prefix = start()
      db.create(prefix[0] as Extract<FusionEvent, { type: 'task/created' }>)
      db.append(TaskId('task'), 1, prefix.slice(1))
      db.append(TaskId('task'), 1, [
        event('report/submitted', 5, { operationId: OperationId('wo-op'), report: report() }),
        event('report/validated', 6, { operationId: OperationId('wo-op'), report: report() }),
      ])
      const requested = reviewRequestedEvent(db.load(TaskId('task'))!, 7, { ticketId: 't-store', requestId: 'req-store' })
      const afterRequest = db.transact(TaskId('task'), 6, current => ({
        events: [requested],
        outbox: [...current.outbox, {
          operationId: OperationId('review-req-store'),
          taskId: TaskId('task'),
          kind: 'review-request',
          state: 'prepared',
        }],
      }))
      const reloaded = new FileFusionStore(dir).load(TaskId('task'))
      expect(reloaded?.activeReviewTicket?.requestId).toBe('req-store')
      expect(reloaded?.activeReviewTicket).toEqual(afterRequest.activeReviewTicket)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const usageKey = { provider: 'p', model: 'm', requestId: 'req', attemptId: 'a', contractDigest: 'c' }
function ingestRaw(items: Array<{ usage: ReturnType<typeof raw>; meta: ReturnType<typeof meta> }>) {
  let ledger = newLedger(usageKey)
  for (const item of items) {
    ledger = ingestDurable(ledger, observationFromNormalized(item.usage, usageKey, item.meta))
  }
  return ledger
}

describe('PR3 round-2 usage ledger', () => {
  it('U01 deserialized replay with the same observationId counts once', () => {
    const first = raw({ outputTokens: 100 })
    const replay = JSON.parse(JSON.stringify(first)) as typeof first
    const ledger = ingestRaw([
      { usage: first, meta: meta('partial', 1, false, 'delta-1') },
      { usage: replay, meta: meta('partial', 1, false, 'delta-1') },
    ])
    expect(projectLedger(ledger).bill?.output).toEqual(known(100))
  })

  it('U02 non-adjacent replay counts once', () => {
    const ledger = ingestRaw([
      { usage: raw({ outputTokens: 100 }), meta: meta('partial', 1, false, 'd1') },
      { usage: raw({ outputTokens: 200 }), meta: meta('partial', 2, false, 'd2') },
      { usage: raw({ outputTokens: 100 }), meta: meta('partial', 1, false, 'd1') },
    ])
    expect(projectLedger(ledger).bill?.output).toEqual(known(300))
  })

  it('U03 final aggregate zero replaces partial TTL detail', () => {
    const quote = quoteLedger(ingestRaw([
      { usage: raw({ cacheWriteByTtl: { '5m': 1000 } }), meta: meta('partial', 1) },
      { usage: raw({ cacheWriteTokens: 0 }), meta: meta('final', 2) },
    ]), { cacheWrite: { default: '1.25', '5m': '1.25' } })
    expect(quote.totalUsd === null || quote.totalUsd === '0').toBe(true)
  })

  it('U04 final unknown output is not backfilled', () => {
    expect(quoteLedger(ingestRaw([
      { usage: raw({ outputTokens: 100 }), meta: meta('partial', 1) },
      { usage: raw({ outputTokens: null }), meta: meta('final', 2) },
    ]), { output: '5' }).totalUsd).toBeNull()
  })

  it('U05 unknown plus known delta stays unknown', () => {
    expect(quoteLedger(ingestRaw([
      { usage: raw({ outputTokens: null }), meta: meta('partial', 1, false) },
      { usage: raw({ outputTokens: 100 }), meta: meta('partial', 2, false) },
    ]), { output: '5' }).totalUsd).toBeNull()
  })

  it('U06 separate reasoning with unknown quantity is not free', () => {
    expect(priceUsage(raw({
      outputTokens: 100,
      reasoningTokens: null,
      outputIncludesReasoning: false,
    }), card).totalUsd).toBeNull()
  })

  it('U07 cumulative then delta adds or rejects', () => {
    const result = attempt(() => projectLedger(ingestRaw([
      { usage: raw({ outputTokens: 100 }), meta: meta('partial', 1, true) },
      { usage: raw({ outputTokens: 50 }), meta: meta('partial', 2, false) },
    ])).bill?.output)
    if (!result.threw) expect(result.returned).toEqual(known(150))
  })

  it('U08 omitted cache-inclusion contract cannot yield a definite total', () => {
    expect(priceUsage(normalizeUsage({
      inputTokens: 1000,
      cacheReadTokens: 800,
      outputTokens: 100,
    }), card).totalUsd).toBeNull()
  })

  it('24 snapshot/delta/final permutations converge', () => {
    const key = { provider: 'p', model: 'm', requestId: 'r', attemptId: 'a', contractDigest: 'c' }
    const bill = (output: number): CanonicalBill => ({
      uncachedInput: na(),
      cacheRead: na(),
      output: known(output),
      cacheWrite: { kind: 'not_applicable' },
      reasoning: { kind: 'not_applicable', tokens: na() },
    })
    const observations: UsageObservation[] = [
      { id: 's1', key, sequence: 1, mode: 'snapshot', bill: bill(10) },
      { id: 'd2', key, sequence: 2, mode: 'delta', bill: bill(5) },
      { id: 'f3', key, sequence: 3, mode: 'final', bill: bill(20) },
      { id: 's1-replay', key, sequence: 1, mode: 'snapshot', bill: bill(10) },
    ]
    const orders = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ]
    for (const orderIdx of orders) {
      for (const replayAt of [0, 1, 2, 3]) {
        let ledger = newLedger(key)
        const sequence = [...orderIdx]
        sequence.splice(replayAt, 0, 3)
        for (const index of sequence) {
          const item = observations[index]!
          ledger = ingestObservation(ledger, item.id === 's1-replay' ? { ...observations[0]!, id: 's1' } : item)
        }
        const projection = projectLedger(ledger)
        expect(projection.authority).toBe('final')
        expect(projection.bill?.output).toEqual(known(20))
      }
    }
  })
})

describe('PR3 round-2 evidence and termination', () => {
  it('E01 same pytest in examples/ is not proof of the main workspace', () => {
    expect(evaluateReport(order(), report(), [evidence({ cwdDigest: hash('/workspace/examples/demo') })], SnapshotId('S2')).verification)
      .not.toBe('verified')
  })

  it('E02 started and completed records cannot change argv', () => {
    expect(evaluateReport(order(), report(), [
      evidence({ state: 'started', exitCode: null, endedAt: null, argvDigest: hash('echo OK') }),
      evidence(),
    ], SnapshotId('S2')).verification).not.toBe('verified')
    expect(attempt(() => resolveInvocation([
      evidence({ state: 'started', exitCode: null, endedAt: null, argvDigest: hash('echo OK') }),
      evidence(),
    ])).threw).toBeTruthy()
  })

  it('E03 conflicting cwd is not equal content', () => {
    expect(evaluateReport(order(), report(), [evidence(), evidence({ cwdDigest: hash('/other') })], SnapshotId('S2')).verification)
      .not.toBe('verified')
  })

  it('E04 same artifact id with a different digest is a conflict', () => {
    expect(evaluateReport(order(), report(), [
      evidence(),
      evidence({ stdout: { ...artifact('out'), digest: hash('different bytes') } }),
    ], SnapshotId('S2')).verification).not.toBe('verified')
  })

  it('P01 conflicting success and aborted terminal evidence cannot approve', () => {
    expect(classifyReview({
      executionPath: 'forced_fusion',
      termination: 'success',
      finishReason: 'aborted',
      rawText: '{"decision":"approve"}',
      parsed: { decision: 'approve' },
    }).decision).not.toBe('approve')
  })

  it('a correctly scoped main-workspace pytest still verifies', () => {
    const check = evidence({ cwdDigest: hash('/workspace') })
    const plan = mainTestPlan(order(), check)
    expect(evaluateReport(withFrozenPlan(order(), plan), report(), [check], SnapshotId('S2'), plannedOptions(plan, [passingReceipt(plan, check)])).verification)
      .toBe('verified')
  })
})
