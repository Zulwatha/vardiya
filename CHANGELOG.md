# Changelog

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

- Node.js 20 or newer
