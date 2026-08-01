# scheduler

Owned by Agent C.

This module owns cron parsing (in-house, no extra dependency), computing next fire times, producing jobs from repeatable schedules via storage `upsertRepeatable` / enqueue, and promoting delayed work in concert with the worker or a lightweight tick loop.

Do not pull in a cron library. Parsing and next-run math stay in this package. Types are frozen in `src/types.ts`.
