# worker

Owned by Agent B.

Pulls jobs from a `Storage` implementation, runs registered handlers under a
concurrency cap, heartbeats while work is active, and shuts down without
dropping in-flight jobs on the floor. Code here talks only to the `Storage`
interface in `src/types.ts`. Do not import `src/storage/`.

Public pieces:

- `WorkerRuntime` in `worker.ts` (claim loop, handlers, events, signals)
- `Semaphore` in `semaphore.ts` (in-house concurrency gate)
- `AdaptivePoller` in `poller.ts` (busy/idle backoff)
- `UnrecoverableError` for dead-letter without retry

Wire this into the `Worker` stub in `src/vardiya.ts` later. Signatures there
stay frozen.

## Lifecycle

```
                  process(name, handler)
                          |
                          v
                     +---------+
                     |  idle   |
                     +----+----+
                          | start()
                          v
                   +------+-------+
          +------->|   running    |<------+
          |        +--+--------+--+       |
          |           |        |          |
          |    claimNext    no job     job done /
          |    (semaphore)     |       fail path
          |           |        v          |
          |           |   AdaptivePoller  |
          |           |   (backoff sleep) |
          |           v                   |
          |      job:active               |
          |      run handler              |
          |      heartbeat tick ---------+
          |           |
          |    complete / fail / dead
          |           |
          +-----------+

                     stop()
                          |
                          v
                   +------+-------+
                   |  stopping    |
                   +------+-------+
                          |
              wait in-flight (drain)
                          |
              abort leftovers + release
                          |
                          v
                   +------+-------+
                   |   stopped    |
                   +--------------+
```

Events this module emits at the right moment:

| Event | When |
| --- | --- |
| `worker:started` | After `start()` begins the loop |
| `job:active` | Job claimed, about to run the handler |
| `job:completed` | Handler returned; `storage.complete` succeeded |
| `job:failed` | Retryable failure; job still eligible for retry |
| `job:dead` | UnrecoverableError, missing handler, or retries exhausted |
| `worker:stopped` | After drain/abort finishes in `stop()` |
| `error` | Unexpected internal/storage problems (process stays up) |

`job:added` is a producer-side event. The worker does not enqueue, so it does
not emit it.

## Shutdown state machine

```
  idle ----start()----> running ----stop()----> stopping ----> stopped
   ^                      |                        |
   |                      | (loop abort)           | drain timeout
   |                      v                        v
   |                 stop claimNext          abort job signals
   |                 finish current          release leftovers
   |                 acquires                (see PROPOSED-CHANGE
   |                                         Storage.release)
   +------ (new WorkerRuntime) --------------+
```

`stop()` never crashes the process. Order of operations:

1. Flip state to `stopping` and abort the poll sleep so the loop exits.
2. Wait up to `drainTimeoutMs` for in-flight handlers to finish.
3. Abort any leftover job `AbortSignal`s.
4. Release those jobs back toward pending (today via `fail` + `retryable` and
   immediate `nextRunAt`; prefer a future `Storage.release`).
5. Emit `worker:stopped`.

`installSignalHandlers()` is opt-in. It hooks SIGINT/SIGTERM to `stop()` and
returns a disposer.

## Delivery guarantee

vardiya is **at-least-once**.

A job moves to `active` when claimed. If the process dies after claim and
before `complete`/`fail`, stall recovery (heartbeat expiry on the storage
side) can put the work back. After a crash mid-handler, the same job id may
run again. Handlers must be safe to run twice, or they must enforce their own
idempotency (for example with `EnqueueOptions.jobId` and side-effect checks).

Exactly-once delivery across a crash boundary is a lie for this design. You
would need distributed transactions between the queue and every side effect
the handler touches. We do not pretend to have that. What you get instead:

- Durable claim in SQLite
- Heartbeats so live work is not reclaimed
- Graceful drain on stop so clean shutdowns finish in-flight work
- At-least-once redelivery when something dies hard

Run the local proof with:

```bash
npx tsx src/worker/selfcheck.ts
```
