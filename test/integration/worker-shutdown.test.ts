import { afterEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import { sleep } from "../../src/util/sleep.js";
import { WorkerRuntime } from "../../src/worker/worker.js";
import { runCleanups } from "../helpers/cleanup.js";

describe("WorkerRuntime graceful shutdown", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    await runCleanups(cleanups);
  });

  it("drains in-flight jobs and leaves no active rows", async () => {
    const storage = new SqliteStorage(":memory:");
    storage.init();

    const worker = new WorkerRuntime(storage, {
      concurrency: 2,
      pollIntervalMs: 20,
      minPollIntervalMs: 5,
      drainTimeoutMs: 3_000,
      heartbeatIntervalMs: 100,
    });
    // LIFO: stop worker before closing storage.
    cleanups.push(() => storage.close());
    cleanups.push(() => worker.stop());

    let started = 0;
    worker.process("slow", async (_job, ctx) => {
      started += 1;
      await sleep(200, ctx.signal).catch(() => undefined);
      return "ok";
    });

    for (let i = 0; i < 4; i++) {
      storage.enqueue({
        queue: "default",
        name: "slow",
        payload: { i },
        options: { maxAttempts: 3, backoff: { type: "fixed", delayMs: 0 } },
      });
    }

    await worker.start();
    // Let the claim loop pick up work.
    await sleep(80);
    expect(started).toBeGreaterThan(0);

    await worker.stop();
    expect(worker.state).toBe("stopped");
    expect(worker.activeCount).toBe(0);

    const counts = storage.counts();
    expect(counts.active).toBe(0);
    // Completed and/or re-queued (pending/delayed) is fine; nothing stuck active.
    expect(counts.completed + counts.pending + counts.delayed + counts.dead).toBe(4);
  });

  it("releases aborted leftovers without burning an attempt", async () => {
    const storage = new SqliteStorage(":memory:");
    storage.init();

    const worker = new WorkerRuntime(storage, {
      concurrency: 1,
      pollIntervalMs: 20,
      minPollIntervalMs: 5,
      drainTimeoutMs: 30,
      heartbeatIntervalMs: 100,
    });
    cleanups.push(() => storage.close());
    cleanups.push(() => worker.stop());

    worker.process("block", async (_job, ctx) => {
      await sleep(10_000, ctx.signal);
    });

    const job = storage.enqueue({
      queue: "default",
      name: "block",
      payload: {},
      options: { maxAttempts: 3 },
    });

    await worker.start();
    await sleep(50);
    expect(storage.getJob(job.id)?.status).toBe("active");
    expect(storage.getJob(job.id)?.attempts).toBe(1);

    await worker.stop();

    const after = storage.getJob(job.id);
    expect(after?.status).toBe("pending");
    expect(after?.attempts).toBe(0);
    expect(after?.lastError).toBeUndefined();
    expect(storage.counts().active).toBe(0);
  });

  it("stop is idempotent when already idle", async () => {
    const storage = new SqliteStorage(":memory:");
    storage.init();
    cleanups.push(() => storage.close());

    const worker = new WorkerRuntime(storage, { concurrency: 1 });
    worker.process("noop", async () => undefined);
    await worker.stop();
    await worker.stop();
    expect(worker.state).toBe("stopped");
  });
});
