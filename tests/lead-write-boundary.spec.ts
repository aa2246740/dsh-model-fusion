import { describe, expect, it } from 'vitest'
import { directWriteLines } from '../src/host/coordinator.js'

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: args }) as never

describe('directWriteLines', () => {
  it('counts written content, not reads or ordinary commands', () => {
    expect(directWriteLines(call('write', { file_path: 'a.py', content: 'a\nb\nc' }))).toBe(3)
    expect(directWriteLines(call('edit', { file_path: 'a.py', old_string: 'x', new_string: 'y\nz' }))).toBe(2)
    expect(directWriteLines(call('read', { file_path: 'a.py' }))).toBe(0)
    expect(directWriteLines(call('bash', { command: 'python3 -m unittest -v' }))).toBe(0)
    expect(directWriteLines(call('bash', { command: 'git status 2>&1 | tail -5' }))).toBe(0)
    expect(directWriteLines(call('bash', { command: "printf 'x' > calc.py" }))).toBe(0)
  })

  it('treats heredocs and multi-line redirected scripts as file writing', () => {
    expect(directWriteLines(call('bash', { command: "cat > big.py <<'EOF'\na\nb\nEOF" }))).toBe(4)
    expect(directWriteLines(call('bash', { command: 'python3 - <<EOF\nprint(1)\nEOF' }))).toBe(3)
    expect(directWriteLines(call('bash', { command: 'echo a > f\necho b >> f' }))).toBe(2)
  })
})

import { substantiveReview } from '../src/host/coordinator.js'
describe('substantiveReview', () => {
  it('rejects stub reasons and accepts a real sentence', () => {
    for (const stub of ['placeholder', 'LGTM', 'ok.', 'accepted', '  ', 'looks good']) expect(substantiveReview(stub)).toBe(false)
    expect(substantiveReview('All 85 tests pass; codec rejects duplicate keys and NaN as the README requires.')).toBe(true)
  })
})

import { normalizeChecks } from '../src/host/coordinator.js'
describe('normalizeChecks', () => {
  it('fills omitted fields without inventing a test count', () => {
    expect(normalizeChecks([{ command: 'make lint' }, { command: 'python3 -m unittest -v', parser: 'unittest' }])).toEqual([
      { id: 'check-1', description: 'make lint', command: 'make lint', kind: 'static-check', parser: 'exit-code', definitionPaths: [] },
      { id: 'check-2', description: 'python3 -m unittest -v', command: 'python3 -m unittest -v', kind: 'test', parser: 'unittest', definitionPaths: [] },
    ])
    expect(normalizeChecks([{ command: 'x', kind: 'test' }])[0]!.parser).toBeUndefined()
  })
})
