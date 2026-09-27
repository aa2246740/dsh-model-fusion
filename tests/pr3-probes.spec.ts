import { acceptedResultFromTicket } from './review-fixture.js'
import { describe, expect, it } from 'vitest'
import { evaluateReport } from '../src/evidence/gate.js'
import { classifyReview, reviewAttemptFields, toReducerReviewDecision } from '../src/review/protocol.js'
import { reviewRequestedEvent } from '../src/review/ticket.js'
import { reduceAll } from '../src/task/reducer.js'
import { ingestDurable, known, newLedger, projectLedger } from '../src/usage/ledger.js'
import { mergeUsageObservations, normalizeUsage, observationFromNormalized, priceUsage } from '../src/usage/normalize.js'
import { mainTestPlan, passingReceipt, plannedOptions, withFrozenPlan } from './planned.js'
import { sha256Hex } from '../src/digest.js'
import { ArtifactId, OperationId, SessionId, SnapshotId, TaskId, WorkOrderId } from '../src/contracts.js'
import type { FusionEvent, ToolEvidence, WorkOrder, WorkerReport } from '../src/contracts.js'

const card = {
  digest: 'test-only-not-a-market-price',
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
    goal: 'fix bug',
    constraints: [],
    acceptance: [{ id: 'must-pass', description: 'required test suite passes', verificationKind: 'test', mandatory: true }],
    allowedPaths: ['src'],
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

function report(ids: string[] = ['out']): WorkerReport {
  return {
    schemaVersion: 1,
    workOrderId: WorkOrderId('work'),
    revision: 1,
    status: 'completed',
    summary: 'done',
    snapshot: SnapshotId('S2'),
    changeManifest: artifact('manifest'),
    coverage: [{ criterionId: 'must-pass', state: 'satisfied', evidenceIds: ids.map(id => ArtifactId(id)), explanation: 'claimed pass' }],
    verification: [],
    unresolved: [],
    questions: [],
  }
}

function ev(overrides: Partial<ToolEvidence> = {}): ToolEvidence {
  return {
    schemaVersion: 1,
    taskId: TaskId('task'),
    operationId: OperationId('check-op'),
    actor: SessionId('worker'),
    nativeToolCallId: 'call-1',
    argvDigest: hash('python -m pytest'),
    cwdDigest: hash('/workspace'),
    inputSnapshot: SnapshotId('S2'),
    outputSnapshot: SnapshotId('S2'),
    exitCode: 0,
    startedAt: '2026-09-20T00:00:00Z',
    endedAt: '2026-09-20T00:00:01Z',
    stdout: artifact('out'),
    stderr: artifact('err'),
    state: 'completed',
    ...overrides,
  }
}

function event(type: FusionEvent['type'], seq: number, payload: FusionEvent['payload']): FusionEvent {
  return {
    schemaVersion: 1,
    id: `e${seq}`,
    taskId: TaskId('task'),
    seq,
    revision: 1,
    type,
    createdAt: '2026-09-20T00:00:00Z',
    causeId: 'repro',
    payload,
  } as FusionEvent
}

function baseEvents(): FusionEvent[] {
  return [
    event('task/created', 1, { parent: SessionId('parent'), selection: { kind: 'profile', profileId: 'fusion-auto' } }),
    event('intent/chosen', 2, { intent: 'DELEGATE' }),
    event('work-order/prepared', 3, { order: order(), reservedChild: SessionId('worker') }),
    event('child/accepted', 4, { operationId: OperationId('wo-op'), child: SessionId('worker'), messageId: 'm1' }),
    event('report/submitted', 5, { operationId: OperationId('wo-op'), report: report() }),
    event('report/validated', 6, { operationId: OperationId('wo-op'), report: report() }),
  ]
}

function completion(seq: number): FusionEvent {
  return event('task/completed', seq, { snapshot: SnapshotId('S2'), verification: 'verified' })
}

const meta = {
  first: { requestId: 'req-1', source: 'partial' as const, sequence: 1, cumulative: true },
  second: { requestId: 'req-1', source: 'final' as const, sequence: 2, cumulative: true },
}

function attempt(fn: () => unknown) {
  try {
    return { returned: fn() }
  } catch (error) {
    return { threw: (error as { code?: string; name?: string }).code ?? (error as Error).name, message: (error as Error).message }
  }
}

describe('PR3 control probes C01-C11', () => {
  it('C01 unknown usage has no total', () => {
    expect(priceUsage(normalizeUsage({}), card).totalUsd).toBeNull()
  })

  it('C02 input-only cost remains incomplete', () => {
    const priced = priceUsage(normalizeUsage({ inputTokens: 1000 }), card)
    expect(priced.status).toBe('incomplete')
    expect(priced.totalUsd).toBeNull()
    expect(priced.observedUsd).toBe('0.001')
  })

  it('C03 authoritative final replaces earlier output count', () => {
    const key = { provider: 'p', model: 'm', requestId: 'req-1', attemptId: 'a', contractDigest: 'c' }
    let ledger = newLedger(key)
    ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ outputTokens: 100 }), key, { ...meta.first, observationId: 'p1' }))
    ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ outputTokens: 10000 }), key, { ...meta.second, observationId: 'f2' }))
    expect(projectLedger(ledger).bill?.output).toEqual(known(10000))
  })

  it('C04 separately billed reasoning is priced once', () => {
    expect(priceUsage(normalizeUsage({
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 1000,
      reasoningTokens: 7000,
      outputIncludesReasoning: false,
    }), card).totalUsd).toBe('0.04')
  })

  it('C05 missing evidence id rejected', () => {
    expect(evaluateReport(order(), report(['missing']), [ev()], SnapshotId('S2')).verification).toBe('unverified')
  })

  it('C06 unfinished evidence rejected', () => {
    expect(evaluateReport(order(), report(), [ev({ state: 'started', exitCode: null, endedAt: null })], SnapshotId('S2')).verification).toBe('unverified')
  })

  it('C07 empty coverage cannot satisfy mandatory criteria', () => {
    expect(evaluateReport(order(), { ...report(), coverage: [] }, [ev()], SnapshotId('S2')).verification).not.toBe('verified')
  })

  it('C08 stale snapshot evidence rejected', () => {
    expect(evaluateReport(order(), report(), [ev({ inputSnapshot: SnapshotId('S1'), outputSnapshot: SnapshotId('S1') })], SnapshotId('S2')).verification).toBe('unverified')
  })

  it('C09 unreferenced old failed check does not poison current passing check', () => {
    const current = ev()
    const plan = mainTestPlan(order(), current)
    expect(evaluateReport(withFrozenPlan(order(), plan), report(), [
      ev({
        operationId: OperationId('old-op'),
        exitCode: 1,
        inputSnapshot: SnapshotId('S1'),
        outputSnapshot: SnapshotId('S1'),
        stdout: artifact('old'),
        stderr: artifact('old-err'),
      }),
      current,
    ], SnapshotId('S2'), plannedOptions(plan, [passingReceipt(plan, current)])).verification).toBe('verified')
  })

  it('C10 length-truncated review cannot approve', () => {
    expect(classifyReview({
      executionPath: 'forced_fusion',
      finishReason: 'length',
      rawText: '{"decision":"approve"}',
      parsed: { decision: 'approve' },
    }).decision).toBe('REVIEW_INCOMPLETE')
  })

  it('C11 immediate completion after incomplete review rejected', () => {
    expect(attempt(() => reduceAll([
      ...baseEvents(),
      event('review/completed', 7, { decision: 'REVIEW_INCOMPLETE' }),
      completion(8),
    ])).threw).toBeTruthy()
  })
})

describe('PR3 adversarial probes R01-R14', () => {
  it('R01 delegated task cannot complete before an accepting review', () => {
    expect(attempt(() => reduceAll([...baseEvents(), completion(7)])).threw).toBeTruthy()
  })

  it('R02 redelivered report cannot clear incomplete-review barrier', () => {
    expect(attempt(() => reduceAll([
      ...baseEvents(),
      event('review/completed', 7, { decision: 'REVIEW_INCOMPLETE' }),
      event('report/validated', 8, { operationId: OperationId('wo-op'), report: report() }),
      completion(9),
    ])).threw).toBeTruthy()
  })

  for (const reason of ['aborted', 'error', 'content_filter', null] as const) {
    it(`R03-${String(reason)} non-success or unknown termination cannot approve`, () => {
      expect(classifyReview({
        executionPath: 'forced_fusion',
        finishReason: reason,
        rawText: '{"decision":"approve"}',
        parsed: { decision: 'approve' },
      }).decision).not.toBe('approve')
    })
  }

  it('R04 explicitly unknown applicable cache read prevents complete total', () => {
    expect(priceUsage(normalizeUsage({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: null,
      inputIncludesCacheRead: false,
    }), card).totalUsd).toBeNull()
  })

  it('R05 explicitly unknown TTL cache-write count prevents complete total', () => {
    expect(priceUsage(normalizeUsage({
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteByTtl: { '1h': null },
    }), card).totalUsd).toBeNull()
  })

  it('R06 final known reasoning contract replaces earlier unspecified contract', () => {
    const key = { provider: 'p', model: 'm', requestId: 'req-1', attemptId: 'a', contractDigest: 'c' }
    let ledger = newLedger(key)
    ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 8000, reasoningTokens: 7000 }), key, { ...meta.first, observationId: 'p1' }))
    ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 8000, reasoningTokens: 7000, outputIncludesReasoning: true }), key, { ...meta.second, observationId: 'f2' }))
    const bill = projectLedger(ledger).bill!
    expect(bill.reasoning.kind).toBe('included')
    expect(bill.output).toEqual(known(8000))
  })

  it('R07 contradictory reasoning contracts never both charged', () => {
    const key = { provider: 'p', model: 'm', requestId: 'req-1', attemptId: 'a', contractDigest: 'c' }
    const result = attempt(() => {
      let ledger = newLedger(key)
      ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 1000, reasoningTokens: 7000, outputIncludesReasoning: false }), key, { ...meta.first, observationId: 'p1' }))
      return ingestDurable(ledger, observationFromNormalized(normalizeUsage({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 8000, reasoningTokens: 7000, outputIncludesReasoning: true }), key, { ...meta.second, observationId: 'f2' }))
    })
    if (!result.threw) {
      const bill = projectLedger(result.returned as ReturnType<typeof newLedger>).bill!
      expect(bill.reasoning.kind).toBe('included')
      expect(bill.reasoning.kind === 'separate').toBe(false)
    }
  })

  it('R08 final TTL breakdown replaces partial aggregate cache-write', () => {
    const key = { provider: 'p', model: 'm', requestId: 'req-1', attemptId: 'a', contractDigest: 'c' }
    let ledger = newLedger(key)
    ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cacheWriteTokens: 1000 }), key, { ...meta.first, observationId: 'p1' }))
    ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cacheWriteByTtl: { '5m': 1000 } }), key, { ...meta.second, observationId: 'f2' }))
    expect(projectLedger(ledger).bill?.cacheWrite.kind).toBe('details')
  })

  it('R09 observations from different requests cannot merge', () => {
    const first = { provider: 'p', model: 'm', requestId: 'req-A', attemptId: 'a', contractDigest: 'c' }
    const second = { ...first, requestId: 'req-B' }
    expect(attempt(() => {
      let ledger = newLedger(first)
      ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ outputTokens: 100 }), first, { requestId: 'req-A', source: 'partial', sequence: 1, observationId: 'a' }))
      return ingestDurable(ledger, observationFromNormalized(normalizeUsage({ outputTokens: 10000 }), second, { requestId: 'req-B', source: 'final', sequence: 2, observationId: 'b' }))
    }).threw).toBeTruthy()
    expect(attempt(() => mergeUsageObservations(
      normalizeUsage({ outputTokens: 100 }),
      normalizeUsage({ outputTokens: 10000 }),
    )).threw).toBeTruthy()
  })

  it('R10 delta observations accumulate exactly once or are rejected', () => {
    const key = { provider: 'p', model: 'm', requestId: 'req-A', attemptId: 'a', contractDigest: 'c' }
    const result = attempt(() => {
      let ledger = newLedger(key)
      ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ outputTokens: 100 }), key, { requestId: 'req-A', source: 'partial', sequence: 1, cumulative: false, observationId: 'd1' }))
      ledger = ingestDurable(ledger, observationFromNormalized(normalizeUsage({ outputTokens: 200 }), key, { requestId: 'req-A', source: 'partial', sequence: 2, cumulative: false, observationId: 'd2' }))
      return projectLedger(ledger).bill?.output
    })
    if (!result.threw) expect(result.returned).toEqual(known(300))
  })

  it('R11 unrelated successful echo is not proof the required tests passed', () => {
    expect(evaluateReport(order(), report(), [ev({ argvDigest: hash('echo OK') })], SnapshotId('S2')).verification).not.toBe('verified')
  })

  it('R12 human acceptance criterion cannot be fulfilled by an ordinary tool exit', () => {
    expect(evaluateReport({
      ...order(),
      acceptance: [{ id: 'must-pass', description: 'human approves delivery', verificationKind: 'human', mandatory: true }],
    }, report(), [ev()], SnapshotId('S2')).verification).not.toBe('verified')
  })

  it('R13 conflicting records under the same evidence identity fail closed independent of input order', () => {
    const good = ev()
    const bad = ev({ exitCode: 1 })
    expect(evaluateReport(order(), report(), [good, bad], SnapshotId('S2')).verification).not.toBe('verified')
    expect(evaluateReport(order(), report(), [bad, good], SnapshotId('S2')).verification).not.toBe('verified')
  })

  it('R14 incomplete review without delivery is not evidence fallback was used', () => {
    const fields = reviewAttemptFields({
      artifactPass: false,
      executionPath: 'forced_fusion',
      classification: classifyReview({ executionPath: 'forced_fusion', finishReason: 'length', rawText: '' }),
      finishReason: 'length',
    })
    expect(fields.deliveredArtifactSource).toBeNull()
    expect(fields.fallbackUsed).toBe(false)
  })

  it('maps classifier approve onto reducer accept', () => {
    expect(toReducerReviewDecision(classifyReview({
      executionPath: 'forced_fusion',
      finishReason: 'stop',
      rawText: '{"decision":"approve"}',
      parsed: { decision: 'approve' },
    }))).toBe('accept')
  })

  it('accepting review then matching verified completion is allowed', () => {
    const requested = reviewRequestedEvent(reduceAll(baseEvents()), 7, { ticketId: 'ticket-1', requestId: 'req-1' })
    const reviewed = acceptedResultFromTicket(requested.payload.ticket, 8, { terminalEvidenceRef: 'term:req-1' })
    const state = reduceAll([
      ...baseEvents(),
      requested,
      reviewed,
      completion(9),
    ])
    expect(state.phase).toBe('COMPLETED')
    expect(state.reviewGate?.terminalStatus).toBe('accepting')
    expect(state.acceptedReview?.ticket.requestId).toBe('req-1')
  })
})
