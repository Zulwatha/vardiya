# storage

Owned by Agent A.

This module owns the SQLite persistence layer behind the `Storage` interface in `src/types.ts`. That means opening the database file, migrations, atomic `claimNext`, enqueue/complete/fail paths, delayed promotion, repeatable upserts, heartbeats, cancel, counts, and cleanup.

Do not change `src/types.ts`. If the contract is missing something you need, add a `PROPOSED-CHANGE` comment block in your PR description or next to the call site, and keep your local code compiling against the frozen types.
