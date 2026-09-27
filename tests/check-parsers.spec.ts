import { describe, expect, it } from 'vitest'
import { parseTestCounts, parseTestFailures } from '../src/host/native-checks.js'

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
})
