import { describe, expect, it } from 'vitest'
import { classifyReview, reviewAttemptFields } from '../src/review/protocol.js'
import { reduceAll } from '../src/task/reducer.js'
import { CHILD, SNAP, created, envelope, order } from './helpers.js'
import { ArtifactId } from '../src/contracts.js'
import { sha256Hex } from '../src/digest.js'

describe('classifyReview', () => {
  it('does not require review on the DIRECT path', () => {
    const classification = classifyReview({ executionPath: 'direct', finishReason: 'length', rawText: '' })
    expect(classification).toMatchObject({
      reviewStatus: 'not_required',
      decision: 'not_required',
      protocolComplete: true,
      fallbackUsed: false,
    })
  })

  it('maps finish_reason=length to REVIEW_INCOMPLETE and never approves', () => {
    const classification = classifyReview({
      executionPath: 'forced_fusion',
      finishReason: 'length',
      rawText: 'partial REVIEW {',
      parsed: { decision: 'approve' },
    })
    expect(classification.decision).toBe('REVIEW_INCOMPLETE')
    expect(classification.reviewStatus).toBe('incomplete')
    expect(classification.protocolComplete).toBe(false)
    expect(classification.fallbackUsed).toBe(false)
    expect(classification.fallbackRequired).toBe(true)
  })

  it('maps empty output and illegal structure to REVIEW_INCOMPLETE', () => {
    expect(classifyReview({ executionPath: 'forced_fusion', rawText: '   ' }).decision).toBe('REVIEW_INCOMPLETE')
    expect(classifyReview({
      executionPath: 'fusion_auto',
      rawText: 'ok',
      parsed: { verdict: 'ship it' },
    }).decision).toBe('REVIEW_INCOMPLETE')
  })

  it('records artifact pass separately from protocol completion', () => {
    const classification = classifyReview({
      executionPath: 'forced_fusion',
      finishReason: 'length',
      rawText: '',
    })
    expect(reviewAttemptFields({
      artifactPass: true,
      executionPath: 'forced_fusion',
      classification,
      finishReason: 'length',
      deliveredArtifactSource: 'worker_draft_1',
    })).toEqual({
      artifactPass: true,
      executionPath: 'forced_fusion',
      leadReviewStatus: 'incomplete',
      finishReason: 'length',
      protocolComplete: false,
      fallbackUsed: true,
      deliveredArtifactSource: 'worker_draft_1',
    })
  })
})

describe('review reducer', () => {
  it('refuses to complete after REVIEW_INCOMPLETE', () => {
    const report = {
      schemaVersion: 1 as const,
      workOrderId: order().id,
      revision: 1,
      status: 'completed' as const,
      summary: 'done',
      snapshot: SNAP,
      changeManifest: {
        id: ArtifactId('m'),
        digest: sha256Hex('m'),
        ownerTaskId: created().taskId,
        mediaType: 'text/plain',
        bytes: 1,
      },
      coverage: [],
      verification: [],
      unresolved: [],
      questions: [],
    }
    const state = reduceAll([
      created(),
      envelope('intent/chosen', 2, { intent: 'DELEGATE' }),
      envelope('work-order/prepared', 3, { order: order(), reservedChild: CHILD }),
      envelope('child/accepted', 4, { operationId: order().operationId, child: CHILD, messageId: 'm1' }),
      envelope('report/submitted', 5, { operationId: order().operationId, report }),
      envelope('report/validated', 6, { operationId: order().operationId, report }),
      envelope('review/completed', 7, { decision: 'REVIEW_INCOMPLETE' }),
    ])
    expect(state.phase).toBe('NEEDS_DECISION')
    expect(() => reduceAll([
      created(),
      envelope('intent/chosen', 2, { intent: 'DELEGATE' }),
      envelope('work-order/prepared', 3, { order: order(), reservedChild: CHILD }),
      envelope('child/accepted', 4, { operationId: order().operationId, child: CHILD, messageId: 'm1' }),
      envelope('report/submitted', 5, { operationId: order().operationId, report }),
      envelope('report/validated', 6, { operationId: order().operationId, report }),
      envelope('review/completed', 7, { decision: 'REVIEW_INCOMPLETE' }),
      envelope('task/completed', 8, { snapshot: SNAP, verification: 'verified' }),
    ])).toThrowError(/cannot complete from NEEDS_DECISION/)
  })
})
