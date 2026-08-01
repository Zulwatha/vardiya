# test

Owned by Agent D.

Vitest suites live here. Unit tests cover cron, backoff, ids, and the semaphore. Integration tests hit real `SqliteStorage` (`:memory:` and temp files) plus `WorkerRuntime` / `MaintenanceLoop`. The torture suite runs two workers over 20k jobs.

When an implementation file is missing, suites use `describe.skipIf` keyed on `test/helpers/modules.ts` so `npm test` stays green while other agents land code.
