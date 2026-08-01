# scheduler

Owned by Agent C.

In-house cron parsing and next-run math (`cron.ts`), plus the periodic
`MaintenanceLoop` (`scheduler.ts`) that promotes delayed jobs, reclaims stalled
actives, materializes due repeatables, and optionally cleans old terminal rows.

The public `Vardiya` client constructs a `MaintenanceLoop` during `init()` and
stops it on `close()`. Do not pull in a cron library. Do not import storage or
worker implementations; code against the `Storage` interface in `src/types.ts`.
