# vardiya

SQLite-backed job queue for Node.js. No Redis. No drama.

[![CI](https://github.com/Zulwatha/vardiya/actions/workflows/ci.yml/badge.svg)](https://github.com/Zulwatha/vardiya/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/vardiya.svg)](https://www.npmjs.com/package/vardiya)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)
[![license](https://img.shields.io/github/license/Zulwatha/vardiya)](./LICENSE)

vardiya is a SQLite job queue for durable background jobs for Node.js. It is a BullMQ alternative without Redis: a persistent task queue in one file, with retries, priorities, delayed work, and cron jobs. One runtime dependency (`better-sqlite3`). Cron, backoff, and ids are in-house. If your app already lives on a single VPS and you do not want to run Redis just to send email later, this is the library I would reach for.

## Quick start

```bash
npm install vardiya
```

Requires Node >=22. CI tests on Node 22 and 24. `better-sqlite3` is a native addon; you need a toolchain that can build it (or a prebuild for your platform).

```ts
import { Vardiya } from "vardiya";

const v = new Vardiya({ databasePath: "./jobs.sqlite" });
await v.init();

await v.enqueue("email", { to: "a@b.com" }, { delayMs: 5_000 });

const worker = v.createWorker({ concurrency: 4 });
worker.process("email", async (job) => sendEmail(job.payload));
await worker.start();

// later: await v.close();
```

## Why vardiya

Most Node job queues assume a broker. That is the right call when you have many producers across many hosts. It is overkill when you have one Node process (or a handful) and a disk.

vardiya keeps the queue in a SQLite file: WAL mode, atomic claim via a single `UPDATE ... RETURNING`, retries with backoff, delayed jobs, priorities, repeatable cron, stalled-job reclaim. You open a path, enqueue work, run a worker. When the process dies, the file is still there.

## Features

- Durable jobs in one SQLite database (file or `:memory:` for tests)
- Atomic claim safe for multiple worker processes on the same file
- Delays, priorities, custom `jobId` dedup
- Retries with fixed or exponential backoff (optional jitter)
- Dead letter when `maxAttempts` is exhausted
- Repeatable schedules via 5-field cron (plus `@hourly` / `@daily` / `@weekly` / `@monthly`)
- Heartbeats and stalled-job reclaim
- Graceful worker shutdown with drain timeout
- Typed events: `job:added`, `job:active`, `job:completed`, `job:failed`, `job:dead`, `worker:started`, `worker:stopped`, `error`

## Comparison: vardiya vs BullMQ vs pg-boss vs bee-queue

| | vardiya | BullMQ | pg-boss | bee-queue |
| --- | --- | --- | --- | --- |
| Broker required | No (SQLite file) | Redis | Postgres | Redis |
| Persistence | SQLite file | Redis (AOF/RDB) | Postgres | Redis |
| Repeatable jobs | Yes (5-field cron) | Yes | Yes | Limited / DIY |
| Priorities | Yes | Yes | Yes | Yes |
| Delivery guarantee | At-least-once | At-least-once | At-least-once | At-least-once |
| Runtime deps count | 1 (`better-sqlite3`) | Redis client + extras | `pg` | Redis client |

Numbers above are about the usual install story, not a dependency audit of every transitive package. The point is the ops surface: vardiya asks for a file path; the others ask for a server.

## API reference

### `new Vardiya(options)`

```ts
interface VardiyaOptions {
  databasePath: string;       // file path or ":memory:"
  defaultQueue?: string;      // default "default"
  defaultMaxAttempts?: number;
  defaultBackoff?: BackoffOptions;
}
```

Call `await v.init()` before anything else. Call `await v.close()` on shutdown.

### Enqueue a job

```ts
await v.enqueue(name, payload, {
  queue?: string;
  priority?: number;          // higher runs first, default 0
  delayMs?: number;           // mutually exclusive with runAt; runAt wins if both set
  runAt?: number;             // unix ms
  maxAttempts?: number;       // default 1
  backoff?: BackoffOptions;
  jobId?: string;             // idempotency key within the queue
  repeat?: { cron: string; key: string };
});
```

### Retries and exponential backoff

`BackoffOptions`: `{ type: "fixed" | "exponential", delayMs, maxDelayMs?, jitter? }`.
Exponential delay is `delayMs * 2^(attempt - 1)`, capped by `maxDelayMs`. With `jitter: true`, the wait is a uniform pick in `[0, delay]`.

### Workers and concurrency

```ts
const worker = v.createWorker({
  concurrency?: number;       // default 1
  pollIntervalMs?: number;
  queues?: string[];          // omit to claim from all queues
});

worker.process(name, async (job, ctx) => {
  // ctx.signal: aborted on shutdown / timeout
  // ctx.touch(): refresh heartbeat during long work
  // ctx.log(msg): structured log hook
  return result;
});

await worker.start();
await worker.stop();
```

You can also `v.process(name, handler)` for an embedded worker on the client.

### Repeatable cron jobs

```ts
await v.upsertRepeatable({
  queue?: string;
  name: string;
  cron: string;
  key: string;
  payload?: unknown;
  options?: Omit<EnqueueOptions, "repeat" | "delayMs" | "runAt" | "jobId">;
});

await v.listRepeatables(queue?);
```

### Inspection and cleanup

```ts
await v.getJob(id);
await v.cancel(id);
await v.counts(queue?);           // { pending, active, completed, failed, delayed, dead }
await v.cleanup(olderThanMs);     // deletes old completed/dead rows
```

### Events

`Vardiya` and `Worker` extend a typed emitter:

```ts
v.on("job:completed", (job, result) => { /* ... */ });
v.on("job:failed", (job, err) => { /* ... */ });
v.on("job:dead", (job, err) => { /* ... */ });
v.on("error", (err) => { /* ... */ });
```

## Delivery guarantees

vardiya is **at-least-once**. A job can run more than once if a worker dies after doing the work but before `complete` is recorded, or if stall reclaim races a slow handler. That is the honest model for a crash-safe queue. Exactly-once is a marketing word unless you also design the side effects carefully.

Practical advice:

1. Prefer idempotent handlers. Use `job.id` or a business key as a dedup token in your own DB.
2. Pass `jobId` on enqueue when the producer might retry (HTTP handler doubles, etc.).
3. Call `ctx.touch()` (or rely on the automatic heartbeat) for long jobs so stall reclaim does not steal them mid-flight.
4. Use `maxAttempts` and dead letter for poison messages; do not retry forever into a bad payload.

## Benchmarks

Run on your machine:

```bash
npm run bench
```

Sample from this machine (temp-file DB, noop handler, `bench/bench.ts`):

- CPU: 12th Gen Intel Core i9-12900K (24 logical cores)
- RAM: 32 GB
- OS: Windows 10.0.26200 (win32 x64)
- Node: v24.13.0

| Metric | Result |
| --- | --- |
| Enqueue throughput | 13,740 jobs/sec |
| Process throughput (concurrency=1) | 4,649 jobs/sec |
| Process throughput (concurrency=8) | 5,272 jobs/sec |
| Process throughput (concurrency=32) | 4,665 jobs/sec |

_Measured with 20,000 enqueue ops and 10,000 end-to-end jobs on a temp-file SQLite DB. Re-run locally before you quote numbers; disks and CPUs differ._

## When NOT to use vardiya

If you need many app servers claiming from one logical queue across machines, use Redis or Postgres (BullMQ, pg-boss, and friends). SQLite is a single-writer database. Multiple processes on one host sharing a file over a local disk can work; a fleet of hosts fighting over a network SQLite mount will not.

Also skip vardiya if you need rich dashboard UI, rate-limit groups, or sandboxed job processors out of the box. Those are product features other queues spent years on. This library is the durable queue core, not an ops platform.

## FAQ

### Can I use SQLite as a job queue in production?

Yes, for the right shape of app: one host (or a few processes on that host), local disk, and handlers you can make idempotent. SQLite with WAL mode handles concurrent readers and a single writer well. It is not a substitute for Redis or Postgres when many machines need to share one queue.

### Do I need Redis for background jobs in Node.js?

Not always. Redis (or another broker) is the usual answer for multi-host fleets. If you only need durable background jobs for Node.js on one machine, a SQLite job queue like vardiya avoids running and monitoring Redis just for the queue.

### How is this different from BullMQ?

BullMQ is a Redis-backed queue with a large ecosystem (dashboards, rate limits, flows). vardiya is a BullMQ alternative without Redis: same basic ideas (enqueue, workers, retries, cron) persisted in a SQLite file. Smaller ops surface, fewer product features. Pick BullMQ when you already run Redis or need that ecosystem; pick vardiya when a file is enough.

### Does it support cron / repeatable jobs?

Yes. `upsertRepeatable` takes a 5-field cron expression (and aliases like `@hourly`, `@daily`, `@weekly`, `@monthly`). The scheduler materializes due runs into normal jobs. See the Quick start and API sections above.

### Is it safe with multiple workers?

Multiple worker processes on the same local SQLite file are supported. Claim is atomic (`UPDATE ... RETURNING`), so two workers should not get the same pending job. Delivery is still at-least-once, so write handlers that tolerate a rare double run after a crash or stall reclaim.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Ownership map and writing rules live in [AGENTS.md](./AGENTS.md).

## License

MIT
