# test

Owned by Agent D.

Vitest suites live here. Unit tests cover cron, backoff, ids, and the semaphore.
Integration tests hit real `SqliteStorage` (`:memory:` and temp files) plus
`WorkerRuntime` / `MaintenanceLoop`. The torture suite runs two workers over
20k jobs.

Every suite that opens storage or starts a worker/maintenance loop must close
those resources in `afterEach` so vitest fork workers can exit cleanly.
