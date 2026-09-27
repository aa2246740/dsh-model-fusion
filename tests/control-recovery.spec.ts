import { describe, expect, it } from 'vitest'
import { reduce, reduceAll } from '../src/task/reducer.js'
import { OperationId } from '../src/contracts.js'
import { digestOf } from '../src/digest.js'
import { created, envelope, SNAP, TASK } from './helpers.js'

const approval = {
  id: 'approval-1', taskId: TASK, revision: 1, operationId: OperationId('approved-operation'),
  argsDigest: digestOf('args'), snapshot: SNAP, permissionPolicyDigest: digestOf('policy'), state: 'pending' as const,
}

describe('explicit recovery of independent execution gates', () => {
  it('resuming does not approve work or release its budget gate', () => {
    let state = reduceAll([
      created(), envelope('intent/chosen', 2, { intent: 'DIRECT' }),
      envelope('budget/blocked', 3, { reason: 'unknown spend' }),
      envelope('task/paused', 4, { reason: 'user' }),
      envelope('approval/pending', 5, { approval }),
      envelope('task/resumed', 6, { reason: 'user resumed' }),
    ])
    expect(state.phase).toBe('WAITING_APPROVAL')
    expect(state.control).toMatchObject({ mode: 'running', budgetBlocked: true, pendingApprovalIds: ['approval-1'] })
    state = reduce(state, envelope('approval/answered', 7, { approvalId: 'approval-1', state: 'approved' }))
    expect(state.phase).toBe('WAITING_BUDGET')
    expect(() => reduce(state, envelope('task/completed', 8, { snapshot: SNAP, verification: 'unverified' }))).toThrow()
    state = reduce(state, envelope('budget/unblocked', 8, { authorizationId: 'existing-budget-policy' }))
    expect(state.phase).toBe('DIRECT')
    expect(reduce(state, envelope('task/completed', 9, { snapshot: SNAP, verification: 'unverified' })).phase).toBe('COMPLETED')
  })

  it('records reconciliation without overriding a human pause', () => {
    let state = reduceAll([
      created(), envelope('intent/chosen', 2, { intent: 'DIRECT' }),
      envelope('recovery/needed', 3, { reason: 'Host restarted' }),
      envelope('effect/outcome-unknown', 4, { operationId: OperationId('effect'), reason: 'interrupted write' }),
      envelope('task/paused', 5, { reason: 'inspect first' }),
    ])
    expect(() => reduce(state, envelope('effects/reconciled', 6, { snapshot: SNAP, evidenceRef: '', quiescent: true }))).toThrow()
    state = reduce(state, envelope('effects/reconciled', 6, { snapshot: SNAP, evidenceRef: 'owned:receipt', quiescent: true }))
    expect(state.control).toMatchObject({ mode: 'paused', outcomeUnknown: false, recovering: true })
    state = reduce(state, envelope('recovery/reconciled', 7, { snapshot: SNAP, evidenceRef: 'owned:recovery-scan' }))
    expect(state.phase).toBe('PAUSED')
    state = reduce(state, envelope('task/resumed', 8, { reason: 'user approved continuation' }))
    expect(state.phase).toBe('DIRECT')
  })

  it('a rejected approval cannot become executable merely because its pending id was removed', () => {
    const state = reduceAll([
      created(), envelope('intent/chosen', 2, { intent: 'DIRECT' }),
      envelope('approval/pending', 3, { approval }),
      envelope('approval/answered', 4, { approvalId: 'approval-1', state: 'rejected' }),
    ])
    expect(state.control.mode).toBe('paused')
    expect(() => reduce(state, envelope('task/completed', 5, { snapshot: SNAP, verification: 'unverified' }))).toThrow()
    const resumed = reduce(state, envelope('task/resumed', 5, { reason: 'continue with a different action' }))
    expect(resumed.control.mode).toBe('running')
    expect(resumed.pendingApprovals).toEqual({})
  })
})
