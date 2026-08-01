import { afterEach, describe, expect, it } from "vitest";
import { sleep } from "../../src/util/sleep.js";
import { hasSqlite, hasWorkerRuntime } from "../helpers/modules.js";

const ready = hasSqlite && hasWorkerRuntime;

describe.skipIf(!ready)("WorkerRuntime graceful shutdown", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("drains in-flight jobs and leaves no active rows", async () => {
    const { SqliteStorage } = await import("../../src/storage/sqlite.js");
    const { WorkerRuntime } = await import("../../src/worker/worker.js");

    const storage = new SqliteStorage(":memory:");
    storage.init();
    cleanups.push(() => storage.close());

    const worker = new WorkerRuntime(storage, {
      concurrency: 2,
      pollIntervalMs: 20,
      minPollIntervalMs: 5,
      drainTimeoutMs: 3_000,
      heartbeatIntervalMs: 100,
    });
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

  it("stop is idempotent when already idle", async () => {
    const { SqliteStorage } = await import("../../src/storage/sqlite.js");
    const { WorkerRuntime } = await import("../../src/worker/worker.js");

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
