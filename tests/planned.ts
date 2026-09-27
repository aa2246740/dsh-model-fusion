import type { ToolEvidence, WorkOrder } from '../src/contracts.js'
import { digestOf, sha256Hex } from '../src/digest.js'
import { memoryVerificationRegistry, type CheckPlan, type PlannedReceipt, type VerificationRegistry } from '../src/evidence/receipts.js'

export function mainTestPlan(workOrder: WorkOrder, evidence: ToolEvidence, extras: Partial<CheckPlan> = {}): CheckPlan {
  return {
    id: extras.id ?? 'plan-main',
    version: extras.version ?? 1,
    taskId: workOrder.taskId,
    workOrderId: extras.workOrderId ?? workOrder.id,
    revision: extras.revision ?? workOrder.revision,
    criterionId: extras.criterionId ?? workOrder.acceptance[0]!.id,
    kind: extras.kind ?? 'test',
    snapshot: extras.snapshot ?? evidence.inputSnapshot,
    cwdDigest: extras.cwdDigest ?? evidence.cwdDigest,
    argvDigest: extras.argvDigest ?? evidence.argvDigest,
    definitionDigest: extras.definitionDigest ?? sha256Hex('suite'),
    policyDigest: extras.policyDigest ?? sha256Hex('policy'),
    minExecutedTests: extras.minExecutedTests ?? 1,
  }
}

export function passingReceipt(plan: CheckPlan, evidence: ToolEvidence, counts = { executed: 1, passed: 1, failed: 0 }): PlannedReceipt {
  return {
    id: evidence.stdout.id,
    planDigest: digestOf(plan),
    evidence,
    counts,
  }
}

export function withFrozenPlan(workOrder: WorkOrder, plan: CheckPlan): WorkOrder {
  return {
    ...workOrder,
    acceptance: workOrder.acceptance.map(criterion => (
      criterion.id === plan.criterionId
        ? { ...criterion, planId: plan.id, planDigest: digestOf(plan) }
        : criterion
    )),
  }
}

export function plannedOptions(plan: CheckPlan, receipts: readonly PlannedReceipt[]): { registry: VerificationRegistry } {
  return { registry: memoryVerificationRegistry([plan], receipts) }
}
