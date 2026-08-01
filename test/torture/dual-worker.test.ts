import { afterEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import { sleep } from "../../src/util/sleep.js";
import { WorkerRuntime } from "../../src/worker/worker.js";
import { runCleanups } from "../helpers/cleanup.js";
import { createTempDbPath } from "../helpers/temp-db.js";

const JOB_COUNT = 20_000;
const FAIL_RATE = 0.01;

describe("torture: dual workers / 20k jobs", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    await runCleanups(cleanups);
  });

  it("completes or dead-letters every job with no lost or duplicated successes", async () => {
    // File-backed so two runtimes share one durable queue (WAL).
    const tmp = createTempDbPath("vardiya-torture-");

    const storage = new SqliteStorage(tmp.path);
    storage.init();

    const succeeded = new Set<string>();
    const duplicates: string[] = [];
    let handlerCalls = 0;

    const makeWorker = () => {
      const worker = new WorkerRuntime(storage, {
        concurrency: 10,
        pollIntervalMs: 50,
        minPollIntervalMs: 1,
        drainTimeoutMs: 30_000,
        heartbeatIntervalMs: 500,
        queues: ["torture"],
      });
      worker.process("work", async (job) => {
        handlerCalls += 1;
        if (Math.random() < FAIL_RATE) {
          throw new Error("random failure");
        }
        if (succeeded.has(job.id)) {
          duplicates.push(job.id);
        }
        succeeded.add(job.id);
        return true;
      });
      return worker;
    };

    const w1 = makeWorker();
    const w2 = makeWorker();
    // LIFO: stop workers, close storage, then remove the temp dir.
    cleanups.push(tmp.cleanup);
    cleanups.push(() => storage.close());
    cleanups.push(() => w1.stop());
    cleanups.push(() => w2.stop());

    for (let i = 0; i < JOB_COUNT; i++) {
      storage.enqueue({
        queue: "torture",
        name: "work",
        payload: { i },
        options: {
          jobId: `job-${i}`,
          maxAttempts: 8,
          backoff: { type: "fixed", delayMs: 0, jitter: false },
        },
      });
    }

    await Promise.all([w1.start(), w2.start()]);

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      // Retries with delayMs 0 land as pending; still promote any delayed rows.
      storage.promoteDelayed(Date.now());
      const counts = storage.counts("torture");
      const terminal = counts.completed + counts.dead;
      if (terminal >= JOB_COUNT && counts.active === 0 && counts.pending === 0) {
        break;
      }
      await sleep(25);
    }

    await Promise.all([w1.stop(), w2.stop()]);
    storage.promoteDelayed(Date.now());

    const final = storage.counts("torture");
    expect(final.active).toBe(0);
    expect(final.pending).toBe(0);
    expect(final.delayed).toBe(0);
    expect(final.completed + final.dead).toBe(JOB_COUNT);
    expect(duplicates).toEqual([]);
    expect(succeeded.size).toBe(final.completed);
    expect(handlerCalls).toBeGreaterThanOrEqual(JOB_COUNT);
  }, 180_000);
});
