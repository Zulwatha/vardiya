/**
 * Manual proof that WorkerRuntime meets its contract.
 *
 * Run: `npx tsx src/worker/selfcheck.ts`
 *
 * Uses an in-memory Storage mock (not src/storage/) so this module stays
 * independent of Agent A's implementation.
 */

import type {
  ClaimedJob,
  EnqueueInput,
  FailInput,
  Job,
  JobCounts,
  RepeatableJob,
  Storage,
} from "../types.js";
import { sleep } from "../util/sleep.js";
import { UnrecoverableError, WorkerRuntime } from "./worker.js";

let passed = 0;
let failed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    failed += 1;
    console.error(`FAIL: ${message}`);
    throw new Error(message);
  }
  passed += 1;
  console.log(`ok  - ${message}`);
}

/** Minimal in-memory Storage used only by this selfcheck. */
class MemoryStorage implements Storage {
  readonly jobs = new Map<string, Job>();
  readonly heartbeats = new Map<string, number>();
  #seq = 0;

  init(): void {}
  migrate(): void {}
  close(): void {}

  enqueue<T = unknown>(input: EnqueueInput<T>): Job<T> {
    const now = Date.now();
    const id = input.options?.jobId ?? `job-${++this.#seq}`;
    const existing = this.jobs.get(id);
    if (existing) {
      return existing as Job<T>;
    }
    const maxAttempts = input.options?.maxAttempts ?? 1;
    const runAt = input.options?.runAt ?? now + (input.options?.delayMs ?? 0);
    const job: Job<T> = {
      id,
      queue: input.queue,
      name: input.name,
      payload: input.payload,
      status: runAt > now ? "delayed" : "pending",
      priority: input.options?.priority ?? 0,
      attempts: 0,
      maxAttempts,
      runAt,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, job as Job);
    return job;
  }

  claimNext(queues: string[], now: number): ClaimedJob | null {
    const candidates = [...this.jobs.values()]
      .filter((j) => {
        if (j.status !== "pending") return false;
        if (j.runAt > now) return false;
        if (queues.length > 0 && !queues.includes(j.queue)) return false;
        return true;
      })
      .sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        if (a.runAt !== b.runAt) return a.runAt - b.runAt;
        return a.createdAt - b.createdAt;
      });

    const job = candidates[0];
    if (!job) return null;

    job.status = "active";
    job.attempts += 1;
    job.updatedAt = now;
    this.heartbeats.set(job.id, now);
    return { job };
  }

  complete(id: string, _result?: unknown): void {
    const job = this.require(id);
    job.status = "completed";
    job.updatedAt = Date.now();
    this.heartbeats.delete(id);
  }

  fail(input: FailInput): Job {
    const job = this.require(input.id);
    const now = Date.now();
    job.lastError = input.error;
    job.updatedAt = now;

    const retryable = input.retryable !== false;
    const attemptsLeft = job.attempts < job.maxAttempts;

    if (retryable && attemptsLeft) {
      // Shutdown release: put back to pending without burning semantics hard.
      if (input.error === "released by worker shutdown") {
        job.status = "pending";
        job.attempts = Math.max(0, job.attempts - 1);
        job.runAt = input.nextRunAt ?? now;
        this.heartbeats.delete(job.id);
        return job;
      }
      job.status = "pending";
      job.runAt = input.nextRunAt ?? now;
      this.heartbeats.delete(job.id);
      return job;
    }

    job.status = "dead";
    this.heartbeats.delete(job.id);
    return job;
  }

  moveToDead(id: string, error: string): void {
    const job = this.require(id);
    job.status = "dead";
    job.lastError = error;
    job.updatedAt = Date.now();
    this.heartbeats.delete(id);
  }

  promoteDelayed(now: number): number {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "delayed" && job.runAt <= now) {
        job.status = "pending";
        job.updatedAt = now;
        n += 1;
      }
    }
    return n;
  }

  upsertRepeatable(
    repeatable: Omit<RepeatableJob, "createdAt" | "updatedAt" | "nextRunAt"> & {
      nextRunAt?: number;
    },
  ): RepeatableJob {
    const now = Date.now();
    const row: RepeatableJob = {
      queue: repeatable.queue,
      name: repeatable.name,
      cron: repeatable.cron,
      key: repeatable.key,
      payload: repeatable.payload,
      options: repeatable.options,
      createdAt: now,
      updatedAt: now,
    };
    if (repeatable.nextRunAt !== undefined) {
      row.nextRunAt = repeatable.nextRunAt;
    }
    return row;
  }

  listRepeatables(): RepeatableJob[] {
    return [];
  }

  heartbeat(id: string, now: number): void {
    if (this.jobs.has(id)) {
      this.heartbeats.set(id, now);
    }
  }

  cancel(id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === "pending" || job.status === "delayed") {
      job.status = "dead";
      job.updatedAt = Date.now();
    }
    return job;
  }

  getJob(id: string): Job | null {
    return this.jobs.get(id) ?? null;
  }

  counts(queue?: string): JobCounts {
    const counts: JobCounts = {
      pending: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      dead: 0,
    };
    for (const job of this.jobs.values()) {
      if (queue !== undefined && job.queue !== queue) continue;
      counts[job.status] += 1;
    }
    return counts;
  }

  cleanup(): number {
    return 0;
  }

  private require(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    return job;
  }
}

async function testConcurrencyCap(): Promise<void> {
  const storage = new MemoryStorage();
  for (let i = 0; i < 8; i++) {
    storage.enqueue({ queue: "default", name: "work", payload: { i } });
  }

  let inflight = 0;
  let maxInflight = 0;

  const worker = new WorkerRuntime(storage, {
    concurrency: 3,
    pollIntervalMs: 50,
    minPollIntervalMs: 5,
    heartbeatIntervalMs: 1000,
  });

  worker.process("work", async () => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await sleep(40);
    inflight -= 1;
  });

  await worker.start();
  await waitUntil(() => storage.counts().completed === 8, 5000);
  await worker.stop();

  assert(maxInflight <= 3, `concurrency cap respected (max was ${maxInflight})`);
  assert(storage.counts().completed === 8, "all concurrent jobs completed");
}

async function testTimeoutAborts(): Promise<void> {
  const storage = new MemoryStorage();
  storage.enqueue({
    queue: "default",
    name: "slow",
    payload: {},
    options: { maxAttempts: 2 },
  });

  let sawAbort = false;
  const worker = new WorkerRuntime(storage, {
    concurrency: 1,
    pollIntervalMs: 50,
    minPollIntervalMs: 5,
    jobTimeoutMs: 30,
    heartbeatIntervalMs: 1000,
  });

  worker.process("slow", async (_job, ctx) => {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 5000);
      ctx.signal.addEventListener(
        "abort",
        () => {
          sawAbort = true;
          clearTimeout(t);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        },
        { once: true },
      );
    });
  });

  const failedJobs: Job[] = [];
  worker.on("job:failed", (job) => {
    failedJobs.push(job);
  });

  await worker.start();
  await waitUntil(() => sawAbort && failedJobs.length >= 1, 3000);
  await worker.stop();

  assert(sawAbort, "timeout abort signal fired");
  assert(failedJobs.length >= 1, "timed-out job recorded as failed/retryable");
}

async function testGracefulShutdownDrains(): Promise<void> {
  const storage = new MemoryStorage();
  for (let i = 0; i < 3; i++) {
    storage.enqueue({ queue: "default", name: "drain", payload: { i } });
  }

  const worker = new WorkerRuntime(storage, {
    concurrency: 3,
    pollIntervalMs: 50,
    minPollIntervalMs: 5,
    drainTimeoutMs: 2000,
    heartbeatIntervalMs: 1000,
  });

  let started = 0;
  worker.process("drain", async () => {
    started += 1;
    await sleep(80);
  });

  let stopped = false;
  worker.on("worker:stopped", () => {
    stopped = true;
  });

  await worker.start();
  await waitUntil(() => started === 3, 2000);

  const stopPromise = worker.stop();
  await stopPromise;

  assert(stopped, "worker:stopped emitted after drain");
  assert(storage.counts().completed === 3, "graceful shutdown drained in-flight jobs");
  assert(storage.counts().active === 0, "no active jobs left after stop");
}

async function testUnrecoverableSkipsRetries(): Promise<void> {
  const storage = new MemoryStorage();
  storage.enqueue({
    queue: "default",
    name: "boom",
    payload: {},
    options: { maxAttempts: 5 },
  });

  const worker = new WorkerRuntime(storage, {
    concurrency: 1,
    pollIntervalMs: 50,
    minPollIntervalMs: 5,
    heartbeatIntervalMs: 1000,
  });

  let handlerCalls = 0;
  worker.process("boom", async () => {
    handlerCalls += 1;
    throw new UnrecoverableError("do not retry this");
  });

  const dead: Job[] = [];
  worker.on("job:dead", (job) => {
    dead.push(job);
  });

  await worker.start();
  await waitUntil(() => dead.length === 1, 3000);
  // Give a retry window a chance to fire if the worker were wrongly retrying.
  await sleep(150);
  await worker.stop();

  assert(handlerCalls === 1, "UnrecoverableError ran the handler once");
  assert(dead.length === 1, "UnrecoverableError emitted job:dead");
  assert(storage.counts().dead === 1, "job moved to dead letter");
  assert(storage.counts().pending === 0, "UnrecoverableError skipped retries (not pending)");
  const deadJob = dead[0];
  assert(deadJob !== undefined, "dead job event carried a job");
  const job = storage.getJob(deadJob.id);
  assert(job?.attempts === 1, "UnrecoverableError did not consume further attempts");
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await sleep(10);
  }
}

async function main(): Promise<void> {
  console.log("worker selfcheck\n");

  await testConcurrencyCap();
  await testTimeoutAborts();
  await testGracefulShutdownDrains();
  await testUnrecoverableSkipsRetries();

  console.log(`\n${passed} assertions ok, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
