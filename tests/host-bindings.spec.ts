import { afterEach, describe, expect, it } from 'vitest'
import { BindingRepository } from '../src/host/bindings.js'
import { completeProfile } from '../src/profile/resolve.js'
import { SqliteFusionStore } from '../src/task/sqlite-store.js'
import { TaskId } from '../src/contracts.js'

const stores: SqliteFusionStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const prompts = { lead: 'Lead', worker: 'Worker', compact: 'Checkpoint' }
const profile = completeProfile({ id: 'fusion-auto', version: 'faithful-v1', enabled: true,
  lead: { provider: 'configured', model: 'lead' }, worker: { provider: 'configured', model: 'worker' } }, prompts)
function setup() { const store = new SqliteFusionStore(':memory:'); stores.push(store); return { store, bindings: new BindingRepository(store) } }

describe('native session selection persistence', () => {
  it('keeps frozen profiles detached and affects only the selected native session', () => {
    const { bindings } = setup()
    const selected = bindings.select('lead-a', TaskId('task-a'), { profile, prompts })
    selected.prompts.lead = 'tampered'
    expect(bindings.read('lead-a')?.binding.prompts.lead).toBe('Lead')
    expect(bindings.read('lead-b')).toBeUndefined()
    expect(bindings.selected()).toHaveLength(1)
    bindings.clear('lead-a')
    bindings.clear('lead-a')
    expect(bindings.selected()).toHaveLength(0)
    expect(bindings.read('lead-a')?.binding.taskId).toBe('task-a')
  })

  it('rejects schema drift or changed frozen prompt even with a valid document checksum', () => {
    const { store, bindings } = setup()
    bindings.select('lead-a', TaskId('task-a'), { profile, prompts })
    const prior = bindings.read('lead-a')!
    store.writeDocument('binding:lead-a', prior.revision, { ...prior.binding, prompts: { ...prompts, worker: 'changed' } })
    expect(() => bindings.read('lead-a')).toThrow('digest changed')
  })

  it('refuses to overwrite a live selection', () => {
    const { bindings } = setup()
    bindings.select('lead-a', TaskId('task-a'), { profile, prompts })
    expect(() => bindings.select('lead-a', TaskId('task-b'), { profile, prompts })).toThrow('already selected')
  })

  it('keeps a reserved Worker across task rollover but not a new selection', () => {
    const { bindings } = setup()
    bindings.select('lead-a', TaskId('task-a'), { profile, prompts })
    bindings.assignWorker('lead-a', TaskId('task-a'), 'worker-a')
    expect(() => bindings.assignWorker('lead-a', TaskId('task-a'), 'worker-b')).toThrow('cannot change')
    expect(bindings.rollover('lead-a', TaskId('task-a'), TaskId('task-b')).workerId).toBe('worker-a')
    expect(() => bindings.assignWorker('lead-a', TaskId('task-a'), 'worker-a')).toThrow('changed')
    bindings.clear('lead-a')
    expect(bindings.select('lead-a', TaskId('task-c'), { profile, prompts }).workerId).toBeUndefined()
  })
})
