import { afterEach, describe, expect, it, vi } from "vitest";
import { MaintenanceLoop } from "../../src/scheduler/scheduler.js";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import { sleep } from "../../src/util/sleep.js";
import { WorkerRuntime } from "../../src/worker/worker.js";
import { runCleanups } from "../helpers/cleanup.js";

function openMemory(): SqliteStorage {
  const storage = new SqliteStorage(":memory:");
  storage.init();
  return storage;
}

describe("external review claims (phase 1 repros)", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    await runCleanups(cleanups);
  });

  /**
   * CLAIM 1: cancel() on an active job must abort ctx.signal.
   */
  it("claim1: cancel aborts ctx.signal for an active job", async () => {
    const storage = openMemory();
    cleanups.push(() => storage.close());

    const worker = new WorkerRuntime(storage, {
      concurrency: 1,
      pollIntervalMs: 20,
      minPollIntervalMs: 5,
      heartbeatIntervalMs: 50,
      drainTimeoutMs: 2_000,
    });
    cleanups.push(() => worker.stop());

    let signal: AbortSignal | undefined;
    let started = false;
    worker.process("long", async (_job, ctx) => {
      signal = ctx.signal;
      started = true;
      await sleep(30_000, ctx.signal).catch(() => undefined);
    });

    const job = storage.enqueue({
      queue: "c1",
      name: "long",
      payload: {},
    });

    await worker.start();
    const startDeadline = Date.now() + 2_000;
    while (!started && Date.now() < startDeadline) {
      await sleep(20);
    }
    expect(started).toBe(true);
    expect(signal).toBeDefined();
    if (!signal) throw new Error("expected signal");

    const cancelled = storage.cancel(job.id);
    expect(cancelled?.status).toBe("active");

    const abortDeadline = Date.now() + 1_500;
    while (!signal.aborted && Date.now() < abortDeadline) {
      await sleep(50);
    }
    expect(signal.aborted).toBe(true);
  });

  /**
   * CLAIM 2: jobId is an idempotency key within a queue (dedup_key).
   * Same jobId in different queues creates two rows with distinct PKs.
   */
  it("claim2: same jobId is allowed in different queues", () => {
    const storage = openMemory();
    cleanups.push(() => storage.close());

    const a = storage.enqueue({
      queue: "a",
      name: "n",
      payload: { q: "a" },
      options: { jobId: "x" },
    });
    const b = storage.enqueue({
      queue: "b",
      name: "n",
      payload: { q: "b" },
      options: { jobId: "x" },
    });

    expect(a.dedupKey).toBe("x");
    expect(b.dedupKey).toBe("x");
    expect(b.queue).toBe("b");
    expect(b.payload).toEqual({ q: "b" });
    expect(a.id).not.toBe(b.id);
    expect(storage.getJob(a.id)?.queue).toBe("a");
    expect(storage.getJob(b.id)?.queue).toBe("b");
    expect(storage.counts("a").pending).toBe(1);
    expect(storage.counts("b").pending).toBe(1);

    const again = storage.enqueue({
      queue: "a",
      name: "n",
      payload: { q: "a2" },
      options: { jobId: "x" },
    });
    expect(again.id).toBe(a.id);
    expect(again.payload).toEqual({ q: "a" });
  });

  /**
   * CLAIM 3: there is no stored `failed` status; retryable failures use
   * delayed/pending, and counts() has no `failed` field.
   */
  it("claim3: retryable failure uses delayed/pending, not a failed status", () => {
    const storage = openMemory();
    cleanups.push(() => storage.close());

    const job = storage.enqueue({
      queue: "c3",
      name: "flaky",
      payload: {},
      options: {
        maxAttempts: 3,
        backoff: { type: "fixed", delayMs: 60_000, jitter: false },
      },
    });

    expect(storage.claimNext(["c3"], Date.now())).not.toBeNull();
    const updated = storage.fail({ id: job.id, error: "boom", retryable: true });
    expect(updated.status).toBe("delayed");

    const counts = storage.counts("c3");
    expect(counts).not.toHaveProperty("failed");
    expect(counts.delayed).toBe(1);
    expect(counts.pending).toBe(0);
    expect(counts.dead).toBe(0);
  });

  /**
   * CLAIM 4: enqueue(..., { repeat }) plus one maintenance tick must not
   * produce two runnable jobs for the first occurrence.
   */
  it("claim4: enqueue with repeat materializes the first occurrence once", async () => {
    vi.useFakeTimers();
    const t0 = Date.UTC(2024, 0, 1, 12, 0, 0);
    vi.setSystemTime(t0);

    const storage = openMemory();
    cleanups.push(() => storage.close());

    storage.enqueue({
      queue: "c4",
      name: "tick",
      payload: { n: 1 },
      options: {
        repeat: { cron: "0 * * * *", key: "hourly" },
        runAt: t0,
      },
    });

    // Schedule only: no job row until the maintenance tick materializes.
    expect(storage.counts("c4").pending + storage.counts("c4").delayed).toBe(0);

    const loop = new MaintenanceLoop(storage, {
      now: () => Date.now(),
      stalledTimeoutMs: 60_000,
    });
    cleanups.push(async () => {
      loop.stop();
      await loop.waitForIdle();
    });

    await loop.tick();

    const counts = storage.counts("c4");
    const runnable = counts.pending + counts.delayed + counts.active;
    expect(runnable).toBe(1);

    // Process the single occurrence with a counting handler.
    let runs = 0;
    vi.useRealTimers();
    const worker = new WorkerRuntime(storage, {
      concurrency: 1,
      pollIntervalMs: 20,
      minPollIntervalMs: 5,
      heartbeatIntervalMs: 100,
      queues: ["c4"],
    });
    cleanups.push(() => worker.stop());
    worker.process("tick", async () => {
      runs += 1;
    });

    await worker.start();
    const deadline = Date.now() + 2_000;
    while (runs < 1 && Date.now() < deadline) {
      await sleep(20);
    }
    await sleep(200);
    await worker.stop();

    expect(runs).toBe(1);
  });

  /**
   * CLAIM 5: reclaimStale dead-letters when attempts >= max_attempts.
   */
  it("claim5: reclaimStale dead-letters after max attempts", () => {
    vi.useFakeTimers();
    const t0 = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(t0);

    const storage = openMemory();
    cleanups.push(() => storage.close());

    const job = storage.enqueue({
      queue: "c5",
      name: "stall",
      payload: {},
      options: { maxAttempts: 1 },
    });

    const claimed = storage.claimNext(["c5"], Date.now());
    expect(claimed?.job.attempts).toBe(1);

    vi.setSystemTime(t0 + 30_001);
    expect(storage.reclaimStale(Date.now(), 30_000)).toBe(1);

    const after = storage.getJob(job.id);
    expect(after?.status).toBe("dead");
    expect(after?.lastError).toMatch(/stalled/i);
    expect(storage.claimNext(["c5"], Date.now())).toBeNull();
  });

  /**
   * CLAIM 6: complete/fail must not apply when the row is no longer active.
   * (A status guard cannot distinguish two active owners without a lease
   * token; it does stop writes after reclaim-to-pending or after complete.)
   */
  it("claim6: zombie complete and fail do not rewrite non-active rows", () => {
    vi.useFakeTimers();
    const t0 = Date.UTC(2024, 0, 1, 0, 0, 0);
    vi.setSystemTime(t0);

    const storage = openMemory();
    cleanups.push(() => storage.close());

    const job = storage.enqueue({
      queue: "c6",
      name: "work",
      payload: {},
      options: {
        maxAttempts: 3,
        backoff: { type: "fixed", delayMs: 0, jitter: false },
      },
    });

    // Worker A claims, then stalls past the reclaim window.
    expect(storage.claimNext(["c6"], Date.now())).not.toBeNull();
    vi.setSystemTime(t0 + 30_001);
    expect(storage.reclaimStale(Date.now(), 30_000)).toBe(1);
    expect(storage.getJob(job.id)?.status).toBe("pending");

    // Zombie A complete after reclaim must not mark a pending row completed.
    storage.complete(job.id, { from: "zombie-a" });
    expect(storage.getJob(job.id)?.status).toBe("pending");

    // Worker B claims and finishes.
    const b = storage.claimNext(["c6"], Date.now());
    expect(b?.job.id).toBe(job.id);
    expect(b?.job.attempts).toBe(2);
    storage.complete(job.id, { from: "b" });
    expect(storage.getJob(job.id)?.status).toBe("completed");

    // Zombie A fail must not resurrect a completed job.
    const zombieFail = storage.fail({
      id: job.id,
      error: "zombie fail",
      retryable: true,
    });
    expect(zombieFail.status).toBe("completed");
    expect(storage.getJob(job.id)?.status).toBe("completed");
    expect(storage.counts("c6").pending).toBe(0);
    expect(storage.counts("c6").delayed).toBe(0);
  });
});
