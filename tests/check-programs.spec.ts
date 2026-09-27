import { describe, expect, it } from 'vitest'
import { checkPrograms } from '../src/host/native-checks.js'

describe('checkPrograms', () => {
  it('names the program of each simple command segment', () => {
    expect(checkPrograms('cd batchflow-task && python -B -m unittest discover -s tests -v')).toEqual(['cd', 'python'])
    expect(checkPrograms('FOO=1 BAR=2 pytest -q | tee out.txt; npm test || true')).toEqual(['pytest', 'tee', 'npm', 'true'])
    expect(checkPrograms('env -u GIT_CONFIG_COUNT git diff --check')).toEqual(['git'])
    expect(checkPrograms('nice -n 5 time -f %e pytest -q')).toEqual(['pytest'])
    expect(checkPrograms('(cd pkg && node --test)')).toEqual(['cd', 'node'])
  })

  it('does not split inside quoted arguments', () => {
    expect(checkPrograms(`python3 -c "import sys; ok = 1; sys.exit(0 if ok else 1)" && echo 'a; b'`)).toEqual(['python3', 'echo'])
    expect(checkPrograms(`bash -c 'cd x && make test'`)).toEqual(['bash'])
  })

  it('skips heredoc bodies and digests', () => {
    const command = "shasum -a 256 -c - <<'EOF'\n73d4bda9e3988b2a9d44a514b32e0dfc0ff5c9f6f3de78e63bc6a04479bbf3ec  README.md\nEOF\npython3 -m unittest"
    expect(checkPrograms(command)).toEqual(['shasum', 'python3'])
    expect(checkPrograms('echo ok; 42')).toEqual(['echo'])
  })

  it('does not probe a command that sets its own PATH', () => {
    expect(checkPrograms('PATH=/opt/homebrew/bin:$PATH node --test')).toEqual([])
    expect(checkPrograms('export PATH="$HOME/.bun/bin:$PATH"; bun test')).toEqual([])
    expect(checkPrograms('env -i PATH=/bin uv run pytest')).toEqual([])
    expect(checkPrograms('MYPATH=x node --test')).toEqual(['node'])
  })

  it('leaves paths unprobed because an earlier cd changes where they resolve', () => {
    expect(checkPrograms('cd app && ./gradlew test && .venv/bin/python -m pytest')).toEqual(['cd'])
  })
})

describe('probeMissingPrograms', () => {
  it('finds programs through the Host PATH and suggests existing variants', async () => {
    const { probeMissingPrograms } = await import('../src/host/native-checks.js')
    const probe = await probeMissingPrograms(process.cwd(), ['cd', 'node', 'fusion-no-such-program'])
    expect(probe).toEqual({ missing: ['fusion-no-such-program'], alternatives: { 'fusion-no-such-program': [] }, locations: { 'fusion-no-such-program': [] } })
  })

  it('names where a program off the PATH is installed', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { programLocations } = await import('../src/host/native-checks.js')
    const home = mkdtempSync(join(tmpdir(), 'fusion-home-'))
    for (const dir of ['.nvm/versions/node/v20.1.0/bin', '.nvm/versions/node/v22.11.0/bin', '.bun/bin']) mkdirSync(join(home, dir), { recursive: true })
    for (const file of ['.nvm/versions/node/v20.1.0/bin/fusion-tool', '.nvm/versions/node/v22.11.0/bin/fusion-tool', '.bun/bin/fusion-tool']) writeFileSync(join(home, file), '', { mode: 0o755 })
    writeFileSync(join(home, '.bun/bin/not-executable'), '', { mode: 0o644 })
    expect(programLocations('fusion-tool', home)).toEqual([join(home, '.bun/bin/fusion-tool'), join(home, '.nvm/versions/node/v22.11.0/bin/fusion-tool'), join(home, '.nvm/versions/node/v20.1.0/bin/fusion-tool')])
    expect(programLocations('not-executable', home)).toEqual([])
  })
})
