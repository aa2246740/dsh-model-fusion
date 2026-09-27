import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ArtifactId, OperationId, SessionId, SnapshotId, TaskId, WorkOrderId } from '../src/contracts.js'
import { APPROVAL_SCOPE, FUSION_CONTEXT_BUDGET, PROFILE_UNAVAILABLE } from '../src/errors.js'
import { answerApproval, consumeApproval, neverMeansDeny, pendingDoesNotExpire } from '../src/approval/logical.js'
import { assertFinalBudget, boundedOverflowRecovery, inputBudget, measureRequest } from '../src/context/guard.js'
import { evaluateReport } from '../src/evidence/gate.js'
import { order } from './helpers.js'
import { completeProfile, resolveProfile } from '../src/profile/resolve.js'
import { loadPromptBundle } from '../src/prompts.js'
import { reconcile } from '../src/recovery/reconcile.js'
import { sha256Hex } from '../src/digest.js'
import { expectCode } from './helpers.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const prompts = loadPromptBundle(join(root, 'prompts'))

describe('profile resolver', () => {
  it('uses the physical window by default while preserving explicit and previously frozen soft targets', () => {
    const current = completeProfile({}, prompts)
    for (const role of ['lead', 'worker'] as const) {
      const policy = current.context[role]
      const budget = inputBudget(policy, 128000, 12000, 'heuristic')
      expect(budget).toBe(108000)
      expect(budget).toBeLessThan(128000 - 12000)
    }
    const explicit = completeProfile({ context: { lead: { targetInputTokens: 32000 }, worker: { targetInputTokens: 96000 } } }, prompts)
    expect(inputBudget(explicit.context.lead, 128000, 12000)).toBe(32000)
    expect(completeProfile(explicit as unknown as Record<string, unknown>, prompts).context).toEqual(explicit.context)
  })
  it('rejects invalid context policies instead of weakening final admission', () => {
    for (const lead of [{ minSafetyTokens: -1 }, { targetInputTokens: NaN }, { reserveOutputTokens: 0 },
      { safetyFraction: -0.1 }, { compactToFraction: 1 }]) {
      expectCode(() => completeProfile({ context: { lead } }, prompts), PROFILE_UNAVAILABLE)
    }
  })
  it('refuses the shipped example because it is disabled and uses placeholders', () => {
    const raw = JSON.parse(readFileSync(join(root, 'profiles/fusion-auto.example.json'), 'utf8')) as Record<string, unknown>
    const completed = completeProfile(raw, prompts)
    expect(completed.enabled).toBe(false)
    expectCode(() => resolveProfile(raw, prompts, { authorizedRoutes: [] }), PROFILE_UNAVAILABLE)
  })

  it('accepts only authorized concrete routes', () => {
    const raw = {
      schemaVersion: 1,
      id: 'fusion-auto',
      version: '0.1.0-experimental',
      enabled: true,
      quality: 'experimental',
      lead: { provider: 'test', model: 'lead-1' },
      worker: { provider: 'test', model: 'worker-1' },
      dataPolicyId: 'local',
      context: {},
    }
    expectCode(
      () => resolveProfile(raw, prompts, { authorizedRoutes: [{ provider: 'test', model: 'lead-1' }] }),
      PROFILE_UNAVAILABLE,
    )
    const resolved = resolveProfile(raw, prompts, {
      authorizedRoutes: [
        { provider: 'test', model: 'lead-1' },
        { provider: 'test', model: 'worker-1' },
      ],
    })
    expect(resolved.profile.digest).toHaveLength(64)
    expect(resolved.profile.promptDigests.lead).toBe(sha256Hex(prompts.lead))
  })
})

describe('context guard', () => {
  const policy = {
    targetInputTokens: 32_000,
    reserveOutputTokens: 8_000,
    minSafetyTokens: 2_048,
    safetyFraction: 0.05,
    compactToFraction: 0.5,
    evidenceReadTokens: 4_000,
    maxToolVisibleTokens: 6_000,
  }

  it('counts cache reads toward the window and sends zero downstream calls on overflow', () => {
    const window = 16_000
    const budget = inputBudget(policy, window, 4_000)
    expect(budget).toBeLessThan(window)
    const measurement = measureRequest({
      systemTokens: 2_000,
      messageTokens: 2_000,
      toolSchemaTokens: 1_000,
      cacheReadTokens: 20_000,
      reservedOutputTokens: 4_000,
      contextWindow: window,
      quality: 'exact',
    }, policy)
    expect(measurement.inputTokens).toBe(25_000)
    expectCode(() => assertFinalBudget(measurement, policy), FUSION_CONTEXT_BUDGET)
  })

  it('stops overflow recovery after two non-shrinking attempts', () => {
    expect(boundedOverflowRecovery([{ projectionTokens: 100 }, { projectionTokens: 100 }])).toBe('needs-decision')
    expect(boundedOverflowRecovery([{ projectionTokens: 100 }, { projectionTokens: 80 }])).toBe('continue')
  })
})

describe('logical approval', () => {
  const approval = {
    id: 'appr-1',
    taskId: TaskId('task-1'),
    revision: 1,
    operationId: OperationId('op-1'),
    argsDigest: sha256Hex('args'),
    snapshot: SnapshotId('snap'),
    permissionPolicyDigest: sha256Hex('policy'),
    state: 'pending' as const,
  }

  it('never expires a pending human approval', () => {
    expect(pendingDoesNotExpire(approval, Date.now() + 86_400_000 * 8)).toBe(true)
    expect(neverMeansDeny('never')).toBe(true)
  })

  it('consumes an approval once and rejects a changed snapshot', () => {
    const approved = answerApproval(approval, 'approved')
    const consumed = consumeApproval(approved, {
      argsDigest: approval.argsDigest,
      snapshot: approval.snapshot,
      permissionPolicyDigest: approval.permissionPolicyDigest,
    })
    expect(consumed.state).toBe('consumed')
    expectCode(() => consumeApproval(consumed, {
      argsDigest: approval.argsDigest,
      snapshot: approval.snapshot,
      permissionPolicyDigest: approval.permissionPolicyDigest,
    }), APPROVAL_SCOPE)
    expectCode(() => consumeApproval(approved, {
      argsDigest: approval.argsDigest,
      snapshot: SnapshotId('other'),
      permissionPolicyDigest: approval.permissionPolicyDigest,
    }), APPROVAL_SCOPE)
  })
})

describe('evidence gate', () => {
  it('does not verify a passing claim when the tool exit code is nonzero', () => {
    const snapshot = SnapshotId('snap')
    const artifact = {
      id: ArtifactId('a'),
      digest: sha256Hex('out'),
      ownerTaskId: TaskId('task-1'),
      mediaType: 'text/plain',
      bytes: 1,
    }
    const verdict = evaluateReport(order(), {
      schemaVersion: 1,
      workOrderId: WorkOrderId('wo-1'),
      revision: 1,
      status: 'completed',
      summary: 'tests passed',
      snapshot,
      changeManifest: artifact,
      coverage: [{ criterionId: 't1', state: 'satisfied', evidenceIds: [artifact.id], explanation: 'said so' }],
      verification: [artifact],
      unresolved: [],
      questions: [],
    }, [{
      schemaVersion: 1,
      taskId: TaskId('task-1'),
      operationId: OperationId('op-1'),
      actor: SessionId('worker'),
      nativeToolCallId: 'call-1',
      argvDigest: sha256Hex('npm test'),
      cwdDigest: sha256Hex('/tmp'),
      inputSnapshot: snapshot,
      outputSnapshot: snapshot,
      exitCode: 1,
      startedAt: 't0',
      endedAt: 't1',
      stdout: artifact,
      stderr: artifact,
      state: 'completed',
    }], snapshot)
    expect(verdict.verification).toBe('unverified')
  })
})

describe('recovery', () => {
  it('retries a prepared missing child with the reserved id and refuses to invent a new one after accept', () => {
    const prepared = reconcile({
      outbox: {
        operationId: OperationId('op-1'),
        taskId: TaskId('task-1'),
        kind: 'delegate',
        state: 'prepared',
        reservedChild: SessionId('child-1'),
      },
      childPersistence: 'missing',
      effectKnown: true,
      reportAlreadyRecorded: false,
      parentDelivered: false,
    })
    expect(prepared).toEqual({ action: 'retry-prepare', child: SessionId('child-1') })
    const acceptedMissing = reconcile({
      outbox: {
        operationId: OperationId('op-1'),
        taskId: TaskId('task-1'),
        kind: 'delegate',
        state: 'accepted',
        reservedChild: SessionId('child-1'),
        nativeMessageId: 'm1',
      },
      childPersistence: 'missing',
      effectKnown: true,
      reportAlreadyRecorded: false,
      parentDelivered: false,
    })
    expect(acceptedMissing.action).toBe('needs-repair')
  })

  it('returns a stored result instead of re-delivering a duplicate report', () => {
    const decision = reconcile({
      outbox: {
        operationId: OperationId('op-1'),
        taskId: TaskId('task-1'),
        kind: 'delegate',
        state: 'result-recorded',
      },
      childPersistence: 'present',
      effectKnown: true,
      reportAlreadyRecorded: true,
      parentDelivered: false,
    })
    expect(decision).toEqual({ action: 'return-stored-result' })
    expect(reconcile({
      outbox: {
        operationId: OperationId('op-1'),
        taskId: TaskId('task-1'),
        kind: 'delegate',
        state: 'delivered',
      },
      childPersistence: 'present',
      effectKnown: true,
      reportAlreadyRecorded: true,
      parentDelivered: true,
    }).action).toBe('idle')
  })
})
