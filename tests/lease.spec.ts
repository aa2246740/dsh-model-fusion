import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OperationId, SessionId, TaskId } from '../src/contracts.js'
import { LEASE_BUSY, LEASE_GENERATION } from '../src/errors.js'
import { canonicalWorkspace, classifyEffect, leasePath, WorkspaceWriteLease } from '../src/execution/write-lease.js'
import { expectCode } from './helpers.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

describe('WorkspaceWriteLease', () => {
  it('allows only one writer generation on a workspace', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dmf-lease-'))
    dirs.push(cwd)
    const gate = new WorkspaceWriteLease(join(cwd, 'lease-registry'))
    const first = gate.acquire({
      cwd,
      holder: SessionId('worker-1'),
      taskId: TaskId('task-1'),
      operationId: OperationId('op-1'),
    })
    expect(first.generation).toBe(1)
    expectCode(() => gate.acquire({
      cwd,
      holder: SessionId('lead-1'),
      taskId: TaskId('task-1'),
      operationId: OperationId('op-2'),
    }), LEASE_BUSY)
    gate.assertGeneration(first, 1)
    expectCode(() => gate.assertGeneration(first, 0), LEASE_GENERATION)
    gate.release(first)
    const second = gate.acquire({
      cwd,
      holder: SessionId('lead-1'),
      taskId: TaskId('task-1'),
      operationId: OperationId('op-3'),
    })
    expect(second.generation).toBe(2)
    expectCode(() => gate.assertGeneration(first, first.generation), LEASE_GENERATION)
    gate.release(first)
    expect(gate.stillHeld(second)).toBe(true)
    gate.release(second)
  })

  it('coordinates independent handles and canonical symlink paths', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dmf-lease-')); dirs.push(cwd)
    const alias = join(cwd, 'alias'); const nested = mkdtempSync(join(cwd, 'target-')); symlinkSync(nested, alias)
    const first = new WorkspaceWriteLease(join(cwd, 'lease-registry')); const second = new WorkspaceWriteLease(join(cwd, 'lease-registry'))
    const input = { cwd: alias, holder: SessionId('worker'), taskId: TaskId('task'), operationId: OperationId('op') }
    const held = first.acquire(input)
    expect(second.current(nested)).toEqual(held)
    expectCode(() => second.acquire({ ...input, cwd: nested }), LEASE_BUSY)
    second.release(held)
    const next = first.acquire(input)
    expect(next.generation).toBe(2)
    first.release(next)
  })

  it('refuses incomplete legacy locks instead of racing to unlink them', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dmf-lease-')); dirs.push(cwd)
    const root = join(cwd, 'lease-registry')
    const lock = leasePath(canonicalWorkspace(cwd), root); mkdirSync(dirname(lock), { recursive: true })
    writeFileSync(lock, '')
    try {
      expectCode(() => new WorkspaceWriteLease(root).acquire({ cwd, holder: SessionId('worker'), taskId: TaskId('task'), operationId: OperationId('op') }), LEASE_BUSY)
      expect(existsSync(lock)).toBe(true)
    } finally { rmSync(lock) }
  })

  it('treats unknown shell as writable', () => {
    expect(classifyEffect('unknown-shell')).toBe('write')
    expect(classifyEffect('read-tool')).toBe('read')
  })
})
