# Vardiya public facade: implementation plan

This is the wiring guide for the integration agent filling `src/vardiya.ts`.
Signatures on `Vardiya` / `Worker` are frozen. Fill bodies only. Do not import
concrete classes from outside the agreed construction sites; depend on
`Storage`, `MaintenanceLoop`, and `WorkerRuntime` interfaces/types.

Target: a working client in under an hour if storage, worker, and scheduler
modules already build.

## Final shape (mapped to frozen API)

The frozen class already exposes the right verbs. Map the informal names from
the brief onto them like this:

| Informal name | Frozen API | Notes |
|---|---|---|
| `new Vardiya(dbPath, opts)` | `new Vardiya({ databasePath, ...opts })` | `VardiyaOptions.databasePath` is required |
| `.add(name, payload, opts)` | `.enqueue(name, payload, opts)` | same semantics |
| `.worker(opts)` | `.createWorker(opts)` | returns `Worker` stub backed by WorkerRuntime |
| `.events` | the instance itself | `Vardiya extends TypedEmitter<VardiyaEvents>` |
| `.shutdown()` | `.close()` | stop maintenance + workers, then `storage.close()` |

Fluent `.queue(name)` is not on the frozen class. Do not add it in this pass.
If product wants it later, propose:

```ts
/*
 * PROPOSED-CHANGE:
 * What: add Vardiya.queue(name): QueueHandle with .enqueue/.process/.counts
 * Why: nicer multi-queue ergonomics without repeating { queue } in options
 * Suggested shape: queue(name: string): QueueHandle
 */
```

## Construction and owned resources

```ts
// inside Vardiya
private storage!: SchedulerStorage; // SqliteStorage, cast/typed with reclaimStale
private maintenance?: MaintenanceLoop;
private workers: Worker[] = [];
private defaultQueue: string;
```

Constructor stays a pure options freeze (already done). Real I/O happens in
`init()`:

```ts
async init(): Promise<void> {
  const { SqliteStorage } = await import("./storage/sqlite.js");
  // Or static import once the integration module layout is settled.
  this.storage = new SqliteStorage(this.options.databasePath);
  await Promise.resolve(this.storage.init());

  this.maintenance = new MaintenanceLoop(this.storage, {
    // sane defaults live in MaintenanceLoop; override only if opts grow later
  });
  this.maintenance.start();
}
```

`SchedulerStorage` is `Storage & { reclaimStale(...) }`. SqliteStorage must
expose `reclaimStale` (see PROPOSED-CHANGE in `scheduler.ts`). Until
`types.ts` gains the method, construct with a narrow cast at the wiring site:

```ts
this.storage = new SqliteStorage(path) as SchedulerStorage;
```

## Method bodies (copy-paste sketch)

### enqueue

```ts
async enqueue<T>(name: string, payload: T, options?: EnqueueOptions & { queue?: string }): Promise<Job<T>> {
  const queue = options?.queue ?? this.options.defaultQueue ?? "default";
  const { queue: _q, ...rest } = options ?? {};
  void _q;

  const merged: EnqueueOptions = {
    maxAttempts: rest.maxAttempts ?? this.options.defaultMaxAttempts,
    backoff: rest.backoff ?? this.options.defaultBackoff,
    ...rest,
  };

  // If repeat is set and this is the schedule registration path, also upsert.
  if (merged.repeat) {
    const cron = merged.repeat.cron;
    const key = merged.repeat.key;
    const nextRunAt = nextRun(cron, new Date()).getTime();
    await Promise.resolve(
      this.storage.upsertRepeatable({
        queue,
        name,
        cron,
        key,
        payload,
        options: {
          priority: merged.priority,
          maxAttempts: merged.maxAttempts,
          backoff: merged.backoff,
        },
        nextRunAt,
      }),
    );
  }

  const job = await Promise.resolve(
    this.storage.enqueue({ queue, name, payload, options: merged }),
  );
  this.emit("job:added", job);
  return job;
}
```

Prefer registering schedules through `upsertRepeatable` for clarity. If
`enqueue` with `repeat` both inserts a template job and upserts the schedule,
document that choice once and stick to it. Recommended: `upsertRepeatable`
owns the schedule; `enqueue` with `repeat` is sugar that upserts then enqueues
the first occurrence with `jobId = repeatOccurrenceJobId(queue, key, nextRunAt)`
only when you want an eager first fire. Otherwise just upsert with `nextRunAt`
and let `MaintenanceLoop` materialize.

### upsertRepeatable

```ts
async upsertRepeatable(input): Promise<RepeatableJob> {
  const queue = input.queue ?? this.options.defaultQueue ?? "default";
  const nextRunAt = nextRun(input.cron, new Date()).getTime();
  return this.storage.upsertRepeatable({
    queue,
    name: input.name,
    cron: input.cron,
    key: input.key,
    payload: input.payload ?? {},
    options: input.options ?? {},
    nextRunAt,
  });
}
```

Always set `nextRunAt` via `nextRun` from `src/scheduler/cron.ts` so the
maintenance loop has a concrete due time.

### process / createWorker

`process` on `Vardiya` registers a handler on an embedded worker (create lazily
on first `process` or first `createWorker`).

```ts
createWorker(options?: WorkerOptions): Worker {
  const worker = new Worker({
    databasePath: this.options.databasePath,
    ...options,
  });
  // Agent B: Worker body should construct WorkerRuntime(storage or path).
  this.workers.push(worker);
  // Forward worker events onto the client emitter if desired.
  return worker;
}
```

Wire `Worker` to `WorkerRuntime` inside `src/worker/` as Agent B specified.
The facade only constructs, tracks, and stops them.

### close (shutdown)

```ts
async close(): Promise<void> {
  this.maintenance?.stop();
  for (const w of this.workers) {
    await w.stop();
  }
  this.workers = [];
  await Promise.resolve(this.storage.close());
}
```

### Passthroughs

`getJob`, `cancel`, `counts`, `cleanup`, `listRepeatables` are thin storage
delegates. Resolve sync-or-async with `Promise.resolve(...)`.

## Events

Emit from the facade where the action originates:

- `job:added` from `enqueue`
- `worker:started` / `worker:stopped` forwarded from Worker
- `job:active` / `job:completed` / `job:failed` / `job:dead` forwarded from Worker
- `error` for maintenance tick failures (wrap `MaintenanceLoop` tick, or patch
  a small `onError` option later)

Listeners:

```ts
v.on("job:completed", (job, result) => { ... });
v.on("error", (err) => { ... });
```

## Import graph (keep acyclic)

```
vardiya.ts
  -> storage/sqlite.ts      (SqliteStorage)
  -> scheduler/scheduler.ts (MaintenanceLoop)
  -> scheduler/cron.ts      (nextRun)
  -> worker/*               (WorkerRuntime via Worker stub)
  -> util/*                 (TypedEmitter already)
  -> types.ts               (types only)
```

Scheduler must never import storage or worker implementations. Facade is the
only place that touches all three.

## README quick start (10 lines)

Paste this into the root README when docs are written:

```ts
import { Vardiya } from "vardiya";

const v = new Vardiya({ databasePath: "./jobs.sqlite" });
await v.init();

await v.enqueue("email", { to: "a@b.com" }, { delayMs: 5_000 });
await v.upsertRepeatable({
  name: "report",
  cron: "0 9 * * MON-FRI",
  key: "weekday-report",
  payload: { type: "daily" },
});

const worker = v.createWorker({ concurrency: 4 });
worker.process("email", async (job) => sendEmail(job.payload));
worker.process("report", async () => buildReport());
await worker.start();

// later: await v.close();
```

That is the whole product surface for day one: one file database, enqueue,
cron repeatables, a worker, and clean shutdown.
