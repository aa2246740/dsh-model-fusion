import { defineConfig } from 'vitest/config'
import base from './vitest.host.config.mts'

// A single OS process owns the native runtime under test. The parent test
// terminates its process group only after a durable crash-point receipt.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['native-tests/fixtures/process-crash.fixture.ts'],
    pool: 'threads', maxWorkers: 1, fileParallelism: false, testTimeout: 60_000 },
})
