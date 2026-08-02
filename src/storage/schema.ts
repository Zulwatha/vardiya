import type Database from "better-sqlite3";

/**
 * Schema version stamped into `PRAGMA user_version`.
 * Bump when you add a migration below; never reuse a version number.
 */
export const SCHEMA_VERSION = 2;

/**
 * Migration 1: initial jobs + repeatables + meta tables.
 *
 * Index choices (claim hot path):
 * - `idx_jobs_claim (queue, status, priority DESC, run_at, id)`
 *   Matches `claimNext`: filter by queue(s) + `status = 'pending'` +
 *   `run_at <= now`, then `ORDER BY priority DESC, run_at, id LIMIT 1`.
 *   Leading `queue` keeps per-queue claims selective. `status` sits next so
 *   pending rows are a contiguous slice. `priority DESC` is stored descending
 *   so the planner can walk the index in claim order without a sort.
 *   `run_at` then `id` break ties stably (ids are time-sortable).
 *
 * - `idx_jobs_promote (status, run_at) WHERE status = 'delayed'`
 *   Partial index for `promoteDelayed`: only delayed rows, ordered by `run_at`
 *   so `run_at <= now` is a range scan on a small subset.
 *
 * - `idx_jobs_stale (status, heartbeat_at) WHERE status = 'active'`
 *   Partial index for stalled reclaim: active rows whose heartbeat aged out.
 *
 * - `idx_jobs_cleanup (status, updated_at) WHERE status IN ('completed','dead')`
 *   Partial index for `cleanup` of terminal rows by age.
 */
/**
 * Exact SQL for schema version 1. Exported so migration tests can build a
 * real v1 database without editing this string in two places.
 */
export const SCHEMA_V1_SQL = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY NOT NULL,
  queue TEXT NOT NULL,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'active', 'completed', 'failed', 'delayed', 'dead')
  ),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  run_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT,
  cron TEXT,
  repeat_key TEXT,
  heartbeat_at INTEGER,
  backoff_json TEXT,
  result_json TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_jobs_claim
  ON jobs (queue, status, priority DESC, run_at, id);

CREATE INDEX idx_jobs_promote
  ON jobs (status, run_at)
  WHERE status = 'delayed';

CREATE INDEX idx_jobs_stale
  ON jobs (status, heartbeat_at)
  WHERE status = 'active';

CREATE INDEX idx_jobs_cleanup
  ON jobs (status, updated_at)
  WHERE status IN ('completed', 'dead');

CREATE TABLE repeatables (
  queue TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  payload TEXT NOT NULL,
  options_json TEXT NOT NULL,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (queue, key)
);

-- Key/value bookkeeping beyond PRAGMA user_version (library stamp, etc.).
CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;

const MIGRATION_1 = SCHEMA_V1_SQL;

/**
 * Migration 2:
 * - Drop unused `failed` status from the jobs CHECK constraint.
 * - Add `dedup_key` for per-queue idempotency (`EnqueueOptions.jobId`).
 * - `jobs.id` stays the always-unique primary key; caller jobIds move to
 *   `dedup_key` with UNIQUE (queue, dedup_key) WHERE dedup_key IS NOT NULL.
 *
 * Existing rows keep their id and copy it into dedup_key so prior jobId
 * dedup behavior still hits the same row via (queue, dedup_key).
 */
const MIGRATION_2 = `
CREATE TABLE jobs_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  queue TEXT NOT NULL,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'active', 'completed', 'delayed', 'dead')
  ),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  run_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_error TEXT,
  cron TEXT,
  repeat_key TEXT,
  heartbeat_at INTEGER,
  backoff_json TEXT,
  result_json TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  dedup_key TEXT
);

INSERT INTO jobs_v2 (
  id, queue, name, payload, status, priority, attempts, max_attempts,
  run_at, created_at, updated_at, last_error, cron, repeat_key,
  heartbeat_at, backoff_json, result_json, cancel_requested, dedup_key
)
SELECT
  id, queue, name, payload,
  CASE status WHEN 'failed' THEN 'dead' ELSE status END,
  priority, attempts, max_attempts,
  run_at, created_at, updated_at, last_error, cron, repeat_key,
  heartbeat_at, backoff_json, result_json, cancel_requested,
  id
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_v2 RENAME TO jobs;

CREATE INDEX idx_jobs_claim
  ON jobs (queue, status, priority DESC, run_at, id);

CREATE INDEX idx_jobs_promote
  ON jobs (status, run_at)
  WHERE status = 'delayed';

CREATE INDEX idx_jobs_stale
  ON jobs (status, heartbeat_at)
  WHERE status = 'active';

CREATE INDEX idx_jobs_cleanup
  ON jobs (status, updated_at)
  WHERE status IN ('completed', 'dead');

CREATE UNIQUE INDEX idx_jobs_dedup
  ON jobs (queue, dedup_key)
  WHERE dedup_key IS NOT NULL;
`;

type Migration = {
  version: number;
  sql: string;
};

const MIGRATIONS: Migration[] = [
  { version: 1, sql: MIGRATION_1 },
  { version: 2, sql: MIGRATION_2 },
];

/**
 * Apply all pending migrations using `PRAGMA user_version` as the watermark.
 * Safe to call repeatedly. Runs inside a single transaction per version bump.
 */
export function migrate(db: Database.Database): void {
  const current = Number(db.pragma("user_version", { simple: true }));

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
      db.prepare(
        `INSERT INTO meta (key, value) VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run({ key: "schema_version", value: String(migration.version) });
    });

    apply();
  }
}
