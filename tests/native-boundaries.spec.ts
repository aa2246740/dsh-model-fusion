import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { authorizeConfiguredPair, NativeRequestBudget, nativeAuthorization } from '../src/host/native-budget.js'
import { changedPaths, snapshotWorkspace, workspacePath } from '../src/host/workspace.js'
import { parseTestCounts } from '../src/host/native-checks.js'

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'fusion-native-boundaries-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

describe('native evidence and authorization boundaries', () => {
  it('requires an explicit settings authorization and preserves its budget across reopen', () => {
    const root = temp(), path = join(root, 'settings.sqlite'), route = { provider: 'fixture', model: 'model' }
    const store = new SqliteFusionStore(path), budget = new NativeRequestBudget(store)
    const limits = { validHours: 1, maxNativeRequests: 2, maxReservedOutputTokens: 30 }
    expect(() => budget.check([route])).toThrow('设置')
    expect(() => authorizeConfiguredPair(store, [route], limits)).toThrow('请确认')
    expect(store.readDocument('settings:authorization')).toBeUndefined()
    const auth = authorizeConfiguredPair(store, [route], { ...limits, acknowledgeAccountUsage: true, acknowledgeUnknownCost: true })
    budget.reserve(route, 20)
    store.close()
    const reopened = new SqliteFusionStore(path)
    cleanups.push(() => reopened.close())
    const persistent = new NativeRequestBudget(reopened)
    expect(persistent.check([route]).authorizationId).toBe(auth.authorizationId)
    expect(() => persistent.reserve(route, 20)).toThrow('exceeds')
    expect(() => persistent.check([{ provider: 'different', model: 'model' }])).toThrow('outside')
    expect(reopened.readDocument(`budget:${auth.authorizationId}`)?.value).toMatchObject({ requests: 1, reservedOutputTokens: 20, actualBilledUsd: null })
  })

  it('treats omitted caps as none so a saved pair never stalls on a limit the user did not choose', () => {
    const root = temp(), store = new SqliteFusionStore(join(root, 'settings.sqlite')), route = { provider: 'fixture', model: 'model' }
    cleanups.push(() => store.close())
    const auth = authorizeConfiguredPair(store, [route], { acknowledgeAccountUsage: true, acknowledgeUnknownCost: true })
    expect(auth).toMatchObject({ maxNativeRequests: Number.MAX_SAFE_INTEGER, maxReservedOutputTokens: Number.MAX_SAFE_INTEGER })
    expect(Date.parse(auth.expiresAt) - Date.now()).toBeGreaterThan(50 * 365 * 24 * 3600_000)
    const budget = new NativeRequestBudget(store)
    for (let i = 0; i < 200; i++) budget.reserve(route, 131_072)
    expect(() => authorizeConfiguredPair(store, [route], { acknowledgeAccountUsage: true, acknowledgeUnknownCost: true, maxNativeRequests: 0 })).toThrow('超出允许范围')
  }, 30_000)

  it('keeps deleted files and changed symlink targets in the source manifest, and refuses link traversal', () => {
    const root = temp(), project = join(root, 'project')
    mkdirSync(project)
    writeFileSync(join(project, 'file.ts'), 'old')
    symlinkSync('../outside-a', join(project, 'link'))
    const before = snapshotWorkspace(project)
    rmSync(join(project, 'file.ts'))
    rmSync(join(project, 'link'))
    symlinkSync('../outside-b', join(project, 'link'))
    expect(changedPaths(before, snapshotWorkspace(project))).toEqual(['file.ts', 'link'])
    expect(() => workspacePath(project, '../outside')).toThrow('escapes')
    expect(() => workspacePath(project, 'link/child')).toThrow('symlink')
  })

  it('does not infer test completion from zero exit or empty suites; skipped tests are not executed', () => {
    expect(parseTestCounts('unittest', 'Ran 1 test in 0.1s\n\nOK\n')).toEqual({ executed: 1, passed: 1, failed: 0 })
    expect(parseTestCounts('unittest', 'Ran 0 tests in 0.0s\n\nOK\n')).toBeUndefined()
    expect(parseTestCounts('unittest', 'Ran 2 tests in 0.1s\n\nOK (skipped=1)\n')).toEqual({ executed: 1, passed: 1, failed: 0 })
    expect(parseTestCounts('pytest', '1 passed, 1 skipped in 0.1s')).toEqual({ executed: 1, passed: 1, failed: 0 })
    expect(parseTestCounts('unittest', 'Ran 1 test in 0.1s\n\nOK (skipped=1)\n')).toBeUndefined()
    expect(parseTestCounts('vitest', '\n Tests 2 passed (2)\n')).toEqual({ executed: 2, passed: 2, failed: 0 })
    expect(parseTestCounts('tap', '1..2\nok 1\nnot ok 2\n')).toBeUndefined()
    expect(parseTestCounts('exit-code', 'success')).toBeUndefined()
  })

  it('preserves native request reservations after reopening and rejects changed or expired authorization', () => {
    const root = temp(), file = join(root, 'authorization.json'), route = { provider: 'fixture', model: 'model' }
    const auth = { schemaVersion: 1, kind: 'native-fusion-requests', approved: true, authorizationId: 'fixture-approval',
      approvedBy: 'test fixture', expiresAt: '2099-01-01T00:00:00Z', routes: [route], maxNativeRequests: 2,
      maxReservedOutputTokens: 20, costPolicy: 'unknown-cost-acknowledged' }
    writeFileSync(file, JSON.stringify(auth))
    const first = new SqliteFusionStore(join(root, 'store.sqlite'))
    new NativeRequestBudget(first, file).reserve(route, 10)
    first.close()
    const second = new SqliteFusionStore(join(root, 'store.sqlite'))
    cleanups.push(() => second.close())
    const budget = new NativeRequestBudget(second, file)
    expect(() => budget.reserve({ provider: 'other', model: 'model' }, 1)).toThrow('outside')
    writeFileSync(file, JSON.stringify({ ...auth, maxNativeRequests: 3 }))
    expect(() => budget.reserve(route, 10)).toThrow('changed')
    writeFileSync(file, JSON.stringify(auth))
    budget.reserve(route, 10)
    expect(() => budget.reserve(route, 1)).toThrow('exhausted')
    expect(() => nativeAuthorization({ ...auth, expiresAt: '2000-01-01T00:00:00Z' })).toThrow('unexpired')
    expect(() => nativeAuthorization({ ...auth, maximumDollarCost: 1 })).toThrow('money limit')
    expect(second.readDocument('budget:fixture-approval')?.value).toMatchObject({ requests: 2, reservedOutputTokens: 20, actualBilledUsd: null, maximumDollarCost: null })
  })
})
