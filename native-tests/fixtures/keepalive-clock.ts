import type { KeepaliveClock } from '../../src/host/native-keepalive.js'

/** Advances only plugin deadlines; native AgentLoop cancellation keeps real time. */
export class ManualKeepaliveClock implements KeepaliveClock {
  time = 0
  readonly timers = new Map<symbol, { at: number; callback: () => void }>()
  now(): number { return this.time }
  schedule(callback: () => void, delayMs: number): () => void {
    const id = Symbol()
    this.timers.set(id, { at: this.time + delayMs, callback })
    return () => { this.timers.delete(id) }
  }
  advance(ms: number): void {
    this.time += ms
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.time) {
      this.timers.delete(id); timer.callback()
    }
  }
}
