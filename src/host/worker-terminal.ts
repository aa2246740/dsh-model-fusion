/** What fusion_wait should do once the resident Worker handle is already gone. */
export function absentWorkerOutcome(input: { pendingEffects: number; outcomeUnknown: boolean; submitted: boolean }):
  { kind: 'recovery'; reason: string } | { kind: 'collect-report' } | { kind: 'incomplete' } {
  if (input.pendingEffects > 0 || input.outcomeUnknown) {
    return { kind: 'recovery', reason: 'Worker is absent with unfinished native effects; reconcile its persisted session' }
  }
  return input.submitted ? { kind: 'collect-report' } : { kind: 'incomplete' }
}

/** Settlement notice text. It must match whether a report was persisted, and must not send the Lead back to a disposed Worker. */
export function workerSettlementGuidance(submitted: boolean): string {
  if (submitted) {
    return 'The Worker has ended and a structured report is already persisted. This notice is not task acceptance. Review the report and check evidence. Call fusion_wait only if that report has not been returned yet; it reads persisted state and does not restart the Worker.'
  }
  return 'The Worker has ended without a structured report. This notice is not task acceptance, and it is not a provider or quota outage. Call fusion_wait once: it returns the terminal status "worker ended without submitting a report" (WORKFLOW_INCOMPLETE) from persisted state and does not restart the Worker. Do not keep waiting.'
}

/**
 * How to describe a Worker model-control wait to the Lead.
 * WORKFLOW_INCOMPLETE and NO_PROGRESS are missing work, not an unavailable provider.
 */
export function workerStopExplanation(code: string): { reasonCode: string; next: string } {
  if (code === 'WORKFLOW_INCOMPLETE') return {
    reasonCode: 'workflow-incomplete',
    next: 'The required report or workflow transition is missing. This is not a provider outage or quota limit. Do not tell the user the Sidekick or its model is unavailable. Explain the unfinished report and await a user decision.',
  }
  if (code === 'NO_PROGRESS') return {
    reasonCode: 'workflow-incomplete',
    next: 'Repeated unchanged results made no progress. This is not a provider outage or quota limit. Change the approach; do not describe the Sidekick as unavailable.',
  }
  return {
    reasonCode: 'worker-unavailable',
    next: 'Explain which role is unavailable. Use local Fusion controls to continue or replace its model; do not retry delegation or take over automatically.',
  }
}

/** Continue/switch is refused before the route is written. Say so when a switch was requested. */
export function unsettledContinuationError(switching: boolean): { zh: string; en: string } {
  return switching
    ? { zh: '中断的操作尚未确认结束，本次尚未切换模型。请先使用 /fusion recover <检查记录> 核对，再更换并继续。',
      en: 'Interrupted operations are not confirmed finished, so this switch was not applied. Use /fusion recover <inspection note> first, then switch and continue.' }
    : { zh: '中断的操作尚未确认结束，请先使用 /fusion recover 核对',
      en: 'Interrupted operations are not confirmed finished; use /fusion recover first' }
}
