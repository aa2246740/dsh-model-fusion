import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { sha256Hex } from '../digest.js'
import { projectLedger, restoreLedger } from '../usage/ledger.js'
import type { NativeUsageRecord } from '../host/native-usage.js'
import type { FusionStatus, RoleUsage } from '../status.js'

type TaskStatus = NonNullable<FusionStatus['task']>
const metrics = ['calls', 'finalCalls', 'provisionalCalls', 'unreportedCalls', 'compactionCalls', 'keepaliveCalls',
  'inputTokens', 'inputReported', 'cacheReadTokens', 'cacheReadReported', 'outputTokens', 'outputReported', 'unsettled', 'checking', 'workerConversations'] as const
type Metric = typeof metrics[number]
type Totals = Record<Metric, number>
const empty = (): Totals => Object.fromEntries(metrics.map(key => [key, 0])) as Totals
const kinds = ['usage', 'native-effect', 'context-request', 'check-invocation'] as const
const relevant = (id: string) => kinds.some(kind => id.startsWith(`${kind}:`))
const condition = (ref: string) => kinds.map(kind => `${ref}.id GLOB '${kind}:*'`).join(' OR ')

export class StatusDataError extends Error {}
export class StatusPending extends Error {
  constructor(readonly task: string) { super('Status projection needs backfill') }
}

/** Rebuildable read model. Triggers also track writes/deletes by older plugin processes. */
export class StatusIndex {
  readonly #statements = new Map<string, StatementSync>()
  constructor(readonly db: DatabaseSync) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const tablesExist = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('fusion_status_dirty_v1','fusion_status_facts_v1','fusion_status_totals_v1')").get()?.n === 3
      const triggersExist = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('fusion_status_insert_v1','fusion_status_update_v1','fusion_status_delete_v1')").get()?.n === 3
      const exists = tablesExist && triggersExist
      if (!exists) db.exec('DROP TABLE IF EXISTS fusion_status_dirty_v1; DROP TABLE IF EXISTS fusion_status_facts_v1; DROP TABLE IF EXISTS fusion_status_totals_v1;')
      db.exec(`
        CREATE TABLE IF NOT EXISTS fusion_status_dirty_v1 (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS fusion_status_facts_v1 (
          id TEXT PRIMARY KEY, task TEXT NOT NULL, kind TEXT NOT NULL, role TEXT NOT NULL,
          stamp TEXT NOT NULL, session TEXT NOT NULL, active INTEGER NOT NULL, error TEXT,
          preview TEXT NOT NULL, ${metrics.map(key => `${key} INTEGER NOT NULL`).join(',')});
        CREATE INDEX IF NOT EXISTS fusion_status_recent_v1 ON fusion_status_facts_v1(task,kind,stamp DESC,id);
        CREATE INDEX IF NOT EXISTS fusion_status_context_v1 ON fusion_status_facts_v1(task,role,stamp DESC,id) WHERE kind='context-request';
        CREATE INDEX IF NOT EXISTS fusion_status_active_v1 ON fusion_status_facts_v1(task,session) WHERE active=1;
        CREATE INDEX IF NOT EXISTS fusion_status_errors_v1 ON fusion_status_facts_v1(id) WHERE error IS NOT NULL;
        CREATE TABLE IF NOT EXISTS fusion_status_totals_v1 (
          task TEXT NOT NULL, role TEXT NOT NULL, ${metrics.map(key => `${key} INTEGER NOT NULL`).join(',')}, PRIMARY KEY(task,role));
        CREATE TRIGGER IF NOT EXISTS fusion_status_insert_v1 AFTER INSERT ON documents WHEN ${condition('NEW')}
          BEGIN INSERT INTO fusion_status_dirty_v1 VALUES (NEW.id) ON CONFLICT(id) DO NOTHING; END;
        CREATE TRIGGER IF NOT EXISTS fusion_status_update_v1 AFTER UPDATE ON documents WHEN ${condition('NEW')} OR ${condition('OLD')}
          BEGIN INSERT INTO fusion_status_dirty_v1 VALUES (OLD.id) ON CONFLICT(id) DO NOTHING; INSERT INTO fusion_status_dirty_v1 VALUES (NEW.id) ON CONFLICT(id) DO NOTHING; END;
        CREATE TRIGGER IF NOT EXISTS fusion_status_delete_v1 AFTER DELETE ON documents WHEN ${condition('OLD')}
          BEGIN INSERT INTO fusion_status_dirty_v1 VALUES (OLD.id) ON CONFLICT(id) DO NOTHING; END;
      `)
      if (!exists) db.exec(`INSERT OR IGNORE INTO fusion_status_dirty_v1 SELECT id FROM documents WHERE ${condition('documents')}`)
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }

  #sql(sql: string): StatementSync {
    let statement = this.#statements.get(sql)
    if (!statement) { statement = this.db.prepare(sql); this.#statements.set(sql, statement) }
    return statement
  }

  /** Call inside the document transaction, after the source row is written. */
  sync(id: string): void {
    if (!relevant(id)) { this.#sql('DELETE FROM fusion_status_dirty_v1 WHERE id=?').run(id); return }
    const prior = this.#sql('SELECT * FROM fusion_status_facts_v1 WHERE id=?').get(id)
    if (prior) this.#add(String(prior.task), String(prior.role), prior as Totals, -1)
    this.#sql('DELETE FROM fusion_status_facts_v1 WHERE id=?').run(id)
    const source = this.#sql('SELECT json,checksum FROM documents WHERE id=?').get(id)
    if (source) {
      let task = '', role = 'other', stamp = '', session = '', active = 0, error: string | null = null, preview: unknown = {}
      const kind = id.slice(0, id.indexOf(':')), counts = empty()
      try {
        if (typeof source.json !== 'string' || sha256Hex(Buffer.from(source.json)) !== source.checksum) throw new Error('corrupt Host document')
        const row = JSON.parse(source.json)
        task = kind === 'check-invocation' ? row.evidence?.taskId : row.taskId
        if (typeof task !== 'string' || !id.startsWith(`${kind}:${task}:`) || (kind !== 'check-invocation' && row.schemaVersion !== 1)) throw new Error('Fusion 状态记录需要检查')
        role = row.role === 'lead' || row.role === 'worker' ? row.role : 'other'
        if (kind === 'usage') {
          const value = row as NativeUsageRecord, projection = projectLedger(restoreLedger(value.ledger))
          counts.calls = 1
          counts.workerConversations = Number(value.role === 'worker' && (value.purpose === undefined || value.purpose === 'conversation'))
          counts[projection.authority === 'final' ? 'finalCalls' : projection.authority === 'provisional' ? 'provisionalCalls' : 'unreportedCalls'] = 1
          counts.compactionCalls = Number(value.purpose === 'compaction'); counts.keepaliveCalls = Number(value.purpose === 'cache-keepalive')
          for (const [field, count] of [['input', projection.bill?.uncachedInput], ['cacheRead', projection.bill?.cacheRead], ['output', projection.bill?.output]] as const) {
            if (count?.state === 'known') { counts[`${field}Tokens`] = count.tokens; counts[`${field}Reported`] = 1 }
          }
          stamp = value.startedAt; session = value.sessionId
          active = Number(value.purpose === 'conversation' && value.endedAt === null)
          if (!active) session = ''
          preview = { role: value.role, purpose: value.purpose, provider: value.ledger.key.provider, model: value.ledger.key.model,
            outcome: value.outcome, authority: projection.authority }
        } else if (kind === 'native-effect') {
          stamp = row.startedAt; counts.unsettled = Number(row.state === 'dispatch-started' || row.state === 'outcome-unknown')
          preview = { role: row.role, name: row.toolName, state: row.state, failed: row.nativeIsError === true }
        } else if (kind === 'context-request') {
          stamp = row.checkedAt
          preview = { role: row.role, purpose: row.purpose, inputTokens: row.measurement.inputTokens, budget: row.budget,
            quality: row.measurement.quality, admitted: row.admitted, checkedAt: row.checkedAt }
        } else counts.checking = Number(row.evidence.state === 'started')
        if (typeof stamp !== 'string' || typeof session !== 'string') throw new Error('Fusion 状态记录需要检查')
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure)
        task = ''; role = 'other'; stamp = ''; session = ''; active = 0; preview = {}; Object.assign(counts, empty())
      }
      this.#sql(`INSERT INTO fusion_status_facts_v1 VALUES (${Array(9 + metrics.length).fill('?').join(',')})`)
        .run(id, task, kind, role, stamp, session, active, error, JSON.stringify(preview), ...metrics.map(key => counts[key]))
      this.#add(task, role, counts, 1)
    }
    this.#sql('DELETE FROM fusion_status_dirty_v1 WHERE id=?').run(id)
  }

  #add(task: string, role: string, value: Totals, sign: number): void {
    this.#sql(`INSERT INTO fusion_status_totals_v1 VALUES (${Array(2 + metrics.length).fill('?').join(',')})
      ON CONFLICT(task,role) DO UPDATE SET ${metrics.map(key => `${key}=${key}+excluded.${key}`).join(',')}`)
      .run(task, role, ...metrics.map(key => sign * Number(value[key])))
  }

  /** Each batch is its own transaction, so a legacy backfill does not monopolize the writer lock. */
  flushBatch(task: string): boolean {
    let changed = false
    for (const kind of kinds) {
      const batch = this.#sql('SELECT id FROM fusion_status_dirty_v1 WHERE id>=? AND id<? ORDER BY id LIMIT 256')
        .all(`${kind}:${task}:`, `${kind}:${task};`)
      for (const row of batch) { this.sync(String(row.id)); changed = true }
    }
    return changed
  }

  #ready(task: string): void {
    for (const kind of kinds) {
      if (this.#sql('SELECT id FROM fusion_status_dirty_v1 WHERE id>=? AND id<? LIMIT 1').get(`${kind}:${task}:`, `${kind}:${task};`)) {
        throw new StatusPending(task)
      }
    }
  }

  /** Bounded memory even for a legacy database; the surrounding transaction is atomic. */
  flush(task?: string): void {
    const ranges = task === undefined ? [undefined] : kinds.map(kind => [`${kind}:${task}:`, `${kind}:${task};`])
    for (const range of ranges) for (;;) {
      const batch = range
        ? this.#sql('SELECT id FROM fusion_status_dirty_v1 WHERE id>=? AND id<? ORDER BY id LIMIT 256').all(...range)
        : this.#sql('SELECT id FROM fusion_status_dirty_v1 ORDER BY id LIMIT 256').all()
      if (!batch.length) break
      for (const row of batch) this.sync(String(row.id))
    }
  }

  rebuild(): void {
    this.db.exec(`DELETE FROM fusion_status_facts_v1; DELETE FROM fusion_status_totals_v1;
      INSERT OR IGNORE INTO fusion_status_dirty_v1 SELECT id FROM documents WHERE ${condition('documents')}`)
    this.flush()
  }

  #validate(task: string): void {
    for (const kind of kinds) {
      const prefix = `${kind}:${task}:`
      const error = this.#sql('SELECT error FROM fusion_status_facts_v1 WHERE error IS NOT NULL AND id>=? AND id<? LIMIT 1').get(prefix, `${kind}:${task};`)
      if (error) throw new StatusDataError(String(error.error))
    }
  }

  read(task: string): Pick<TaskStatus, 'usage' | 'requests' | 'tools' | 'contexts' | 'unsettledTools'> & { checking: boolean } {
    this.#ready(task)
    this.#validate(task)
    const total = empty(), roles = { lead: empty(), worker: empty() }
    for (const row of this.#sql('SELECT * FROM fusion_status_totals_v1 WHERE task=?').all(task)) {
      for (const key of metrics) total[key] += Number(row[key])
      if (row.role === 'lead' || row.role === 'worker') roles[row.role] = row as Totals
    }
    const own = (value: Totals): RoleUsage => ({ calls: value.calls,
      input: { knownTokens: value.inputTokens, reportedRequests: value.inputReported, totalRequests: value.calls },
      cacheRead: { knownTokens: value.cacheReadTokens, reportedRequests: value.cacheReadReported, totalRequests: value.calls },
      output: { knownTokens: value.outputTokens, reportedRequests: value.outputReported, totalRequests: value.calls } })
    const recent = (kind: string, limit: number) => this.#sql('SELECT id,stamp,preview FROM fusion_status_facts_v1 WHERE task=? AND kind=? ORDER BY stamp DESC,id LIMIT ?')
      .all(task, kind, limit).map(row => ({ ...JSON.parse(String(row.preview)), id: String(row.id), startedAt: String(row.stamp) }))
    return { usage: { ...own(total), finalCalls: total.finalCalls, provisionalCalls: total.provisionalCalls,
      unreportedCalls: total.unreportedCalls, compactionCalls: total.compactionCalls, keepaliveCalls: total.keepaliveCalls,
      actualBilledUsd: null, upstreamHttpCalls: null, byRole: { lead: own(roles.lead), worker: own(roles.worker) } },
      requests: recent('usage', 12), tools: recent('native-effect', 8),
      contexts: (['lead', 'worker'] as const).flatMap(role => {
        const row = this.#sql("SELECT preview FROM fusion_status_facts_v1 WHERE task=? AND kind='context-request' AND role=? ORDER BY stamp DESC,id LIMIT 1").get(task, role)
        return row ? [JSON.parse(String(row.preview))] : []
      }), unsettledTools: total.unsettled, checking: total.checking > 0 }
  }

  workerConversations(task: string): number {
    this.#ready(task)
    this.#validate(task)
    return Number(this.#sql("SELECT workerConversations FROM fusion_status_totals_v1 WHERE task=? AND role='worker'").get(task)?.workerConversations ?? 0)
  }

  hasConversation(task: string, session: string): boolean {
    this.#ready(task)
    this.#validate(task)
    return Boolean(this.#sql('SELECT 1 FROM fusion_status_facts_v1 WHERE task=? AND session=? AND active=1 LIMIT 1').get(task, session))
  }
}
