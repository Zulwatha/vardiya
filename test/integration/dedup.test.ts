import { afterEach, describe, expect, it } from "vitest";
import { SqliteStorage } from "../../src/storage/sqlite.js";
import { runCleanups } from "../helpers/cleanup.js";

function openMemory(): SqliteStorage {
  const storage = new SqliteStorage(":memory:");
  storage.init();
  return storage;
}

describe("per-queue jobId dedup", () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    await runCleanups(cleanups);
  });

  it("returns the same job when jobId is repeated in one queue", () => {
    const storage = openMemory();
    cleanups.push(() => storage.close());

    const first = storage.enqueue({
      queue: "a",
      name: "n",
      payload: { v: 1 },
      options: { jobId: "x" },
    });
    const second = storage.enqueue({
      queue: "a",
      name: "n",
      payload: { v: 2 },
      options: { jobId: "x" },
    });

    expect(second.id).toBe(first.id);
    expect(second.queue).toBe("a");
    expect(second.dedupKey).toBe("x");
    expect(second.payload).toEqual({ v: 1 });
    expect(storage.counts("a").pending).toBe(1);
  });

  it("allows the same jobId in different queues as distinct jobs", () => {
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

    expect(a.id).not.toBe(b.id);
    expect(a.queue).toBe("a");
    expect(b.queue).toBe("b");
    expect(a.dedupKey).toBe("x");
    expect(b.dedupKey).toBe("x");
    expect(storage.getJob(a.id)?.queue).toBe("a");
    expect(storage.getJob(b.id)?.queue).toBe("b");
    expect(storage.counts("a").pending).toBe(1);
    expect(storage.counts("b").pending).toBe(1);
  });

  it("throws when jobId is combined with repeat", () => {
    const storage = openMemory();
    cleanups.push(() => storage.close());

    expect(() =>
      storage.enqueue({
        queue: "r",
        name: "tick",
        payload: {},
        options: {
          jobId: "x",
          repeat: { cron: "0 * * * *", key: "hourly" },
        },
      }),
    ).toThrow(
      "enqueue: jobId cannot be combined with repeat; occurrence ids are generated from the repeat key",
    );
  });
});
