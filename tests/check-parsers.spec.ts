import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkOrder } from '../src/contracts.js'
import { BASELINE_PARSERS, freezeChecks, parseTestCounts, parseTestFailures } from '../src/host/native-checks.js'
import type { CheckDefinition } from '../src/host/native-checks.js'

const passed = (executed: number) => ({ executed, passed: executed, failed: 0 })

describe('test count parsers', () => {
  it('jest counts passed tests of a summary without failures', () => {
    expect(parseTestCounts('jest', 'Test Suites: 2 passed, 2 total\nTests:       12 passed, 12 total\n')).toEqual(passed(12))
    expect(parseTestCounts('jest', 'Tests:       1 failed, 11 passed, 12 total\n')).toBeUndefined()
    expect(parseTestCounts('jest', 'Tests:       2 skipped, 10 passed, 12 total\n')).toEqual(passed(10))
  })

  it('mocha rejects failing tests; pending tests are not executed', () => {
    expect(parseTestCounts('mocha', '  7 passing (20ms)\n')).toEqual(passed(7))
    expect(parseTestCounts('mocha', '  6 passing (20ms)\n  1 failing\n')).toBeUndefined()
    expect(parseTestCounts('mocha', '  6 passing (20ms)\n  1 pending\n')).toEqual(passed(6))
  })

  it('go needs verbose PASS lines and no FAIL; SKIP is not executed', () => {
    expect(parseTestCounts('go', '=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- PASS: TestB (0.00s)\nPASS\nok  \texample\t0.01s\n')).toEqual(passed(2))
    expect(parseTestCounts('go', 'ok  \texample\t0.01s\n')).toBeUndefined()
    expect(parseTestCounts('go', '--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\nFAIL\n')).toBeUndefined()
    expect(parseTestCounts('go', '--- PASS: TestA (0.00s)\n--- SKIP: TestB (0.00s)\n')).toEqual(passed(1))
  })

  it('cargo sums every crate result; ignored tests are not executed', () => {
    expect(parseTestCounts('cargo', 'test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n'
      + 'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n')).toEqual(passed(5))
    expect(parseTestCounts('cargo', 'test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured\n')).toBeUndefined()
    expect(parseTestCounts('cargo', 'test result: ok. 2 passed; 0 failed; 1 ignored; 0 measured\n')).toEqual(passed(2))
    expect(parseTestCounts('cargo', 'test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured\n')).toBeUndefined()
  })

  it('pytest and unittest accept skipped tests but never failures (study 2026-09-26)', () => {
    expect(parseTestCounts('pytest', '....s\n799 passed, 86 skipped in 41.20s\n')).toEqual(passed(799))
    expect(parseTestCounts('pytest', '===== 799 passed, 86 skipped, 3 warnings in 41.20s =====\n')).toEqual(passed(799))
    expect(parseTestCounts('pytest', '12 passed in 0.10s\n')).toEqual(passed(12))
    expect(parseTestCounts('pytest', '1 failed, 11 passed, 2 skipped in 0.30s\n')).toBeUndefined()
    expect(parseTestCounts('pytest', '11 passed, 1 error in 0.30s\n')).toBeUndefined()
    expect(parseTestCounts('pytest', '86 skipped in 0.30s\n')).toBeUndefined()
    expect(parseTestCounts('pytest', '5 passed, 1 subtests passed in 0.02s\n')).toEqual(passed(5))
    expect(parseTestCounts('unittest', 'Ran 10 tests in 0.01s\n\nOK (skipped=3)\n')).toEqual(passed(7))
    expect(parseTestCounts('unittest', 'Ran 10 tests in 0.01s\n\nOK\n')).toEqual(passed(10))
    expect(parseTestCounts('unittest', 'Ran 10 tests in 0.01s\n\nFAILED (failures=1)\n')).toBeUndefined()
    expect(parseTestCounts('unittest', 'Ran 2 tests in 0.01s\n\nOK (unexpected successes=1)\n')).toBeUndefined()
  })

  it('pytest failure lists name every counted failure, or nothing is claimed', () => {
    const out = '..F\n=== short test summary info ===\nFAILED tests/a.py::test_x - AssertionError\nERROR tests/b.py::test_y - fixture\n1 failed, 12 passed, 1 error in 0.50s\n'
    expect(parseTestFailures('pytest', out)).toEqual({ passed: 12, failedIds: ['tests/a.py::test_x', 'tests/b.py::test_y'] })
    expect(parseTestFailures('pytest', '12 passed, 3 skipped in 0.20s\n')).toEqual({ passed: 12, failedIds: [] })
    expect(parseTestFailures('pytest', '2 failed, 10 passed in 0.20s\nFAILED tests/a.py::test_x\n')).toBeUndefined()
    expect(parseTestFailures('unittest', 'OK')).toBeUndefined()
  })

  // Real runner output (stdout, then stderr, as a check records it); go's is hand-written to its documented -v format.
  const output = (parser: string) => readFileSync(join(import.meta.dirname, 'fixtures/test-output', `${parser}.txt`), 'utf8')

  it('every baseline parser names each failure its runner counts', () => {
    expect(parseTestFailures('pytest', output('pytest'))).toEqual({ passed: 2,
      failedIds: ['test_m.py::T::test_err', 'test_m.py::T::test_fail', 'test_m.py::T::test_sub (i=1)'] })
    expect(parseTestFailures('unittest', output('unittest'))).toEqual({ passed: 1,
      failedIds: ['test_err (test_m.T.test_err)', 'test_fail (test_m.T.test_fail)', 'test_sub (test_m.T.test_sub) (i=1)'] })
    expect(parseTestFailures('vitest', output('vitest'))).toEqual({ passed: 1,
      failedIds: ['a.test.mjs > suite > bad', 'a.test.mjs > top bad', 'b.test.mjs > bad'] })
    expect(parseTestFailures('jest', output('jest'))).toEqual({ passed: 1,
      failedIds: ['./a.test.js › bad', './a.test.js › suite › bad', './b.test.js › bad'] })
    expect(parseTestFailures('tap', output('tap'))).toEqual({ passed: 1, failedIds: ['nested', 'subtracts'] })
    expect(parseTestFailures('cargo', output('cargo'))).toEqual({ passed: 1, failedIds: ['tests::bad'] })
    expect(parseTestFailures('go', output('go'))).toEqual({ passed: 2,
      failedIds: ['example.com/m/a TestB', 'example.com/m/a TestC', 'example.com/m/a TestC/one', 'example.com/m/c'] })
    for (const parser of BASELINE_PARSERS) expect(parseTestFailures(parser, output(parser))).toBeDefined()
    expect(parseTestFailures('mocha', '  1 passing\n  1 failing\n\n  1) suite\n       bad:\n')).toBeUndefined()
  })

  it('claims nothing when a counted failure is unnamed or two failures share a name', () => {
    expect(parseTestFailures('unittest', 'FAIL: test_a (m.T.test_a)\nRan 3 tests in 0.01s\n\nFAILED (failures=1, errors=1)\n')).toBeUndefined()
    expect(parseTestFailures('unittest', 'Ran 2 tests in 0.01s\n\nFAILED (unexpected successes=1)\n')).toBeUndefined()
    expect(parseTestFailures('vitest', ' FAIL  a.test.ts [ a.test.ts ]\n      Tests  1 passed (1)\n')).toBeUndefined()
    expect(parseTestFailures('jest', 'FAIL ./a.test.js\n  ● Test suite failed to run\nTests:       1 passed, 1 total\n')).toBeUndefined()
    expect(parseTestFailures('tap', 'not ok 1 - same\nnot ok 2 - same\n1..2\n')).toBeUndefined()
    expect(parseTestFailures('tap', 'ok 1 - a\nnot ok 2\n1..2\n')).toBeUndefined()
    expect(parseTestFailures('tap', 'ok 1 - a\n1..2\n')).toBeUndefined()
    expect(parseTestFailures('cargo', 'test a::t ... FAILED\ntest result: FAILED. 0 passed; 1 failed;\ntest a::t ... FAILED\ntest result: FAILED. 0 passed; 1 failed;\n')).toBeUndefined()
    expect(parseTestFailures('cargo', 'error[E0425]: cannot find value `x`\n')).toBeUndefined()
    expect(parseTestFailures('go', '--- FAIL: TestA (0.00s)\n')).toBeUndefined()
  })

  it('names a TAP failure by its description, not its shifting number', () => {
    expect(parseTestFailures('tap', 'ok 1 - a\nnot ok 2 - b # TODO later\nok 3 - c # SKIP\n1..3\n')).toEqual({ passed: 1, failedIds: ['b'] })
    expect(parseTestFailures('tap', 'ok 1 - new\nok 2 - a\nnot ok 3 - b # TODO later\nok 4 - c # SKIP\n1..4\n')?.failedIds).toEqual(['b'])
  })
})

describe('baseline check definitions', () => {
  const root = mkdtempSync(join(tmpdir(), 'fusion-baseline-'))
  const order = { id: 'wo', taskId: 'task', revision: 1, baseSnapshot: 'snap', policy: {} } as unknown as WorkOrder
  const check = (parser: string) => ({ id: 'suite', description: 'Regression suite', command: 'npm test', kind: 'test' as const,
    parser: parser as CheckDefinition['parser'], definitionPaths: [], baseline: 'no-new-failures' as const })

  it('accepts every parser that names failing tests', () => {
    for (const parser of BASELINE_PARSERS) expect(() => freezeChecks(order, root, [check(parser)])).not.toThrow()
  })

  it('refuses mocha with the retry that works', () => {
    expect(() => freezeChecks(order, root, [check('mocha')])).toThrow(/--reporter tap and parser "tap"/)
  })
})
