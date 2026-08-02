# Changelog

## 0.2.0 - 2026-08-02

### Breaking

- `enqueue(..., { repeat })` no longer inserts an immediate job; the scheduler
  materializes occurrences from the registered schedule.
- `counts()` no longer includes a `failed` field (retries wait in
  `delayed` / `pending`).
- User `jobId` is now a per-queue dedup key exposed as `job.dedupKey`;
  internal `job.id` values are always generated.
- Combining `repeat` with `jobId` on enqueue now throws.

### Fixed

- Active `cancel()` now aborts `ctx.signal` via heartbeat (`cancel_requested`).
  Cancelled active jobs move to `dead` with `last_error = "cancelled"`.
- `reclaimStale` moves jobs with `attempts >= maxAttempts` to `dead` instead of
  looping them forever.
- `complete`, `moveToDead`, and `fail` only mutate rows that are still `active`
  (zombie writers after reclaim cannot complete or resurrect jobs).

### Added

- Schema version 2 migration: `dedup_key` column, partial unique index on
  `(queue, dedup_key)`, and removal of the unused `failed` status from the
  jobs CHECK constraint (`MIGRATION_1` unchanged).
- `typecheck` script (`tsc --noEmit`) and CI step; `prepublishOnly` build;
  `sideEffects: false`; bench script uses `tsx`.

### Changed

- Cron UTC evaluation is documented in the README.
- The `job:failed` event still means "retry scheduled" (not a stored status).

## 0.1.0

First public release of vardiya: a SQLite-backed job queue for Node.js with one
runtime dependency (`better-sqlite3`).

### Added

- `Vardiya` client: `init`, `enqueue`, `process`, `createWorker`, inspection
  helpers (`getJob`, `cancel`, `counts`, `cleanup`), and repeatable cron
  schedules (`upsertRepeatable`, `listRepeatables`).
- `Worker` / `WorkerRuntime`: concurrent claim loop, heartbeats, handler
  timeouts, graceful drain, and typed lifecycle events.
- `SqliteStorage`: WAL mode, atomic `claimNext`, retries with fixed or
  exponential backoff, delayed promotion, stalled-job `reclaimStale`, and
  `release` for shutdown without burning an attempt.
- `MaintenanceLoop`: promotes delayed jobs, reclaims stale actives,
  materializes due repeatables, optional terminal cleanup.
- In-house 5-field cron parser (`nextRun` / `parseCron`) with common aliases.
- Dual ESM + CJS build via tsup, typed exports, vitest suite including a
  dual-worker torture test.

### Requirements

- Node.js 22 or newer
