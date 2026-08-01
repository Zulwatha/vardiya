# scheduler

Owned by Agent C.

In-house cron parsing and next-run math (`cron.ts`), plus the periodic
`MaintenanceLoop` (`scheduler.ts`) that promotes delayed jobs, reclaims stalled
actives, materializes due repeatables, and optionally cleans old terminal rows.

Public facade wiring is documented in `facade-plan.md` for the integration
agent. Run `npx tsx src/scheduler/selfcheck.ts` to verify cron next-run cases.

Do not pull in a cron library. Do not import storage or worker implementations;
code against the `Storage` interface (and the proposed `reclaimStale` method).
Types are frozen in `src/types.ts`.
