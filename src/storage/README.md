# storage

SQLite persistence for vardiya. Owns schema, migrations, and the `Storage`
implementation in `sqlite.ts`.

We use WAL so readers (counts, getJob) do not block writers and writers do not
block readers. SQLite still allows only one writer at a time; under contention
`busy_timeout` waits, then we retry once on `SQLITE_BUSY`.

`claimNext` is a single `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *`.
That beats SELECT-then-UPDATE: two workers cannot both observe the same pending
row and both mark it active. The subquery picks the winner under the write lock;
losers see zero rows.

`reclaimStale` handles abandoned active jobs (stale heartbeat): rows that still
have attempts left go back to `pending`; rows with `attempts >= max_attempts`
move to `dead` with a stalled error. `release` returns a single id to pending
on graceful shutdown and undoes the claim's attempt increment so a clean stop
does not burn a retry.

`jobId` on enqueue is a per-queue dedup key (`dedup_key`), not the row primary
key. `jobs.id` is always generated.

better-sqlite3 is sync. These statements are short; async wrappers would add
Promise overhead without unblocking the event loop during the native call.
Yield between claims if you share one thread.

Expect on the order of tens of thousands of claim/enqueue ops per second on a
local SSD for small payloads, less under heavy multi-process write contention.
Not a distributed broker: one file, one writer lane.
