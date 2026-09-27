-- Optional SQLite task store. Does not replace or share a transaction with DSH Session.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL);
INSERT INTO schema_meta(version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_meta);
CREATE TABLE IF NOT EXISTS tasks (
 task_id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision >= 1),
 state TEXT NOT NULL,
 parent_session_id TEXT NOT NULL,
 profile_digest TEXT NOT NULL,
 state_seq INTEGER NOT NULL DEFAULT 0 CHECK(state_seq >= 0),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
 event_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(task_id),
 seq INTEGER NOT NULL CHECK(seq >= 1),
 revision INTEGER NOT NULL CHECK(revision >= 1),
 type TEXT NOT NULL,
 payload_version INTEGER NOT NULL,
 payload_json TEXT NOT NULL,
 cause_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(task_id,seq)
);
CREATE TABLE IF NOT EXISTS artifacts (
 artifact_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(task_id),
 content_digest TEXT NOT NULL,
 storage_ref TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes >= 0),
 media_type TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS work_orders (
 work_order_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(task_id),
 revision INTEGER NOT NULL,
 child_session_id TEXT NOT NULL,
 status TEXT NOT NULL,
 brief_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id)
);
CREATE TABLE IF NOT EXISTS outbox (
 operation_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(task_id),
 kind TEXT NOT NULL,
 state TEXT NOT NULL,
 payload_artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
 native_message_id TEXT,
 result_artifact_id TEXT REFERENCES artifacts(artifact_id)
);
CREATE TABLE IF NOT EXISTS effects (
 effect_id TEXT PRIMARY KEY,
 operation_id TEXT NOT NULL UNIQUE REFERENCES outbox(operation_id),
 args_digest TEXT NOT NULL,
 snapshot_id TEXT NOT NULL,
 stage TEXT NOT NULL,
 outcome_artifact_id TEXT REFERENCES artifacts(artifact_id)
);
CREATE TABLE IF NOT EXISTS logical_approvals (
 logical_id TEXT PRIMARY KEY,
 effect_id TEXT NOT NULL UNIQUE REFERENCES effects(effect_id),
 decision TEXT NOT NULL CHECK(decision IN ('pending','approved','rejected','withdrawn','consumed')),
 native_request_id TEXT,
 decision_scope_digest TEXT NOT NULL,
 updated_at TEXT NOT NULL
 -- Intentionally no expiry column for pending human decisions.
);
CREATE TABLE IF NOT EXISTS usage_attempts (
 attempt_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(task_id),
 accounting_status TEXT NOT NULL,
 normalized_json TEXT NOT NULL,
 raw_usage_artifact_id TEXT REFERENCES artifacts(artifact_id)
);
CREATE TABLE IF NOT EXISTS leases (
 workspace_id TEXT PRIMARY KEY,
 generation INTEGER NOT NULL CHECK(generation >= 1),
 owner_task_id TEXT NOT NULL REFERENCES tasks(task_id),
 live_process_refs_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_task ON events(task_id,seq);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(state,task_id);
-- Application must perform state/version CAS + event append + outbox write in one transaction.
-- SQL uniqueness is not proof of exactly-once external side effects.
