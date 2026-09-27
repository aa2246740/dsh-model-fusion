import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

interface Receipt { pid: number; taskId: string; point: string; childId?: string; command?: { pid: number; pgid: number } }

function launch(root: string, phase: string, kind: string) {
  const child = spawn(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.crash.config.mts'], {
    cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FUSION_CRASH_ROOT: root, FUSION_CRASH_PHASE: phase, FUSION_CRASH_KIND: kind },
  })
  let output = '', terminal = false
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => { terminal = true; resolve({ code, signal }) })
  })
  return { child, done, output: () => output, terminal: () => terminal,
    stop: async () => {
      if (!terminal) process.kill(-child.pid!, 'SIGKILL')
      await done
    } }
}

async function receipt(root: string, phase: string, run: ReturnType<typeof launch>): Promise<Receipt> {
  const path = join(root, `${phase}.json`), until = Date.now() + 30_000
  while (!existsSync(path)) {
    if (run.terminal() || Date.now() > until) throw new Error(`Missing ${phase} receipt: ${run.output()}`)
    await delay(50)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function terminal(run: ReturnType<typeof launch>) {
  const until = Date.now() + 30_000
  while (!run.terminal()) {
    if (Date.now() > until) throw new Error(`Recovery process did not exit: ${run.output()}`)
    await delay(50)
  }
  return run.done
}

describe('separate native process crash recovery', () => {
  it.each(['approval', 'worker-effect', 'compaction', 'live-command'])('recovers %s without replaying an interrupted action', async kind => {
    const root = mkdtempSync(join(tmpdir(), `fusion-crash-${kind}-`))
    const runs: ReturnType<typeof launch>[] = []
    let command: Receipt['command']
    try {
      const initial = launch(root, 'crash', kind)
      runs.push(initial)
      const stopped = await receipt(root, 'crash', initial)
      expect(stopped.pid).toBe(initial.child.pid)
      expect(stopped.point).toBe(kind)
      command = stopped.command
      if (command) { expect(command.pid).toBeGreaterThan(1); expect(command.pgid).not.toBe(initial.child.pid) }
      process.kill(stopped.pid, 0) // verified live, then deliberately killed
      await initial.stop()
      expect(await initial.done).toMatchObject({ code: null, signal: 'SIGKILL' })
      expect(() => process.kill(stopped.pid, 0)).toThrow()
      writeFileSync(join(root, 'terminated.json'), JSON.stringify({ ...stopped, signal: 'SIGKILL' }))

      if (command) {
        process.kill(command.pid, 0)
        const heartbeat = join(root, 'project', 'heartbeat.txt'), previous = readFileSync(heartbeat, 'utf8')
        await delay(150)
        expect(readFileSync(heartbeat, 'utf8')).not.toBe(previous)
        const observation = launch(root, 'observe', kind)
        runs.push(observation)
        expect(await terminal(observation), observation.output()).toEqual({ code: 0, signal: null })
        expect(await receipt(root, 'observe', observation)).toMatchObject({ liveCommandVerified: true, genericRecoveryRejected: true, requestCount: 0 })
        process.kill(command.pid, 'SIGTERM')
        const deadline = Date.now() + 5000
        for (;;) {
          try { process.kill(command.pid, 0) } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') break
            throw error
          }
          if (Date.now() > deadline) throw new Error('The owned fixture command did not stop')
          await delay(25)
        }
        writeFileSync(join(root, 'command-stopped.json'), JSON.stringify({ pid: command.pid, signal: 'SIGTERM', oldPidAbsent: true }))
        command = undefined // never signal this numeric PID after verified exit
      }

      if (kind === 'compaction') {
        const inspection = launch(root, 'inspect', kind)
        runs.push(inspection)
        expect(await terminal(inspection), inspection.output()).toEqual({ code: 0, signal: null })
        expect((await receipt(root, 'inspect', inspection)).taskId).toBe(stopped.taskId)
      }

      const recovery = launch(root, 'recover', kind)
      runs.push(recovery)
      const result = await terminal(recovery)
      expect(result, recovery.output()).toEqual({ code: 0, signal: null })
      const recovered = await receipt(root, 'recover', recovery)
      expect(recovered.pid).not.toBe(stopped.pid)
      expect(recovered.taskId).toBe(stopped.taskId)
      expect(recovered.childId).toBe(stopped.childId)
      const evidence = process.env.FUSION_CRASH_EVIDENCE_DIR
      if (evidence) {
        mkdirSync(evidence, { recursive: true })
        writeFileSync(join(evidence, `${kind}.json`), JSON.stringify({ schemaVersion: 1,
          classification: 'native-scripted-separate-process-crash', observedAt: new Date().toISOString(),
          crash: stopped, termination: { signal: 'SIGKILL', oldPidAbsent: true },
          inspection: existsSync(join(root, 'inspect.json')) ? JSON.parse(readFileSync(join(root, 'inspect.json'), 'utf8')) : null,
          liveCommandObservation: existsSync(join(root, 'observe.json')) ? JSON.parse(readFileSync(join(root, 'observe.json'), 'utf8')) : null,
          stoppedCommand: existsSync(join(root, 'command-stopped.json')) ? JSON.parse(readFileSync(join(root, 'command-stopped.json'), 'utf8')) : null,
          recovered, actualBilledUsd: null, realProviderRequests: 0,
        }, null, 2) + '\n')
      }
    } finally {
      for (const run of runs) await run.stop()
      if (command) {
        try { process.kill(command.pid, 'SIGKILL') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
