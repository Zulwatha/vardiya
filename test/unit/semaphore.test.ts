import { describe, expect, it } from "vitest";
import { hasSemaphore } from "../helpers/modules.js";

describe.skipIf(!hasSemaphore)("Semaphore", () => {
  it("rejects non-positive counts", async () => {
    const { Semaphore } = await import("../../src/worker/semaphore.js");
    expect(() => new Semaphore(0)).toThrow(/positive integer/);
    expect(() => new Semaphore(-1)).toThrow(/positive integer/);
    expect(() => new Semaphore(1.5)).toThrow(/positive integer/);
  });

  it("tryAcquire consumes permits without waiting", async () => {
    const { Semaphore } = await import("../../src/worker/semaphore.js");
    const sem = new Semaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    expect(sem.available).toBe(0);
  });

  it("acquire waits until release", async () => {
    const { Semaphore } = await import("../../src/worker/semaphore.js");
    const sem = new Semaphore(1);
    await sem.acquire();
    let released = false;
    const waiting = sem.acquire().then(() => {
      released = true;
    });
    expect(sem.pending).toBe(1);
    expect(released).toBe(false);
    sem.release();
    await waiting;
    expect(released).toBe(true);
    expect(sem.available).toBe(0);
  });

  it("hands permits to waiters in FIFO order", async () => {
    const { Semaphore } = await import("../../src/worker/semaphore.js");
    const sem = new Semaphore(1);
    await sem.acquire();
    const order: number[] = [];
    const a = sem.acquire().then(() => {
      order.push(1);
      sem.release();
    });
    const b = sem.acquire().then(() => {
      order.push(2);
    });
    sem.release();
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2]);
  });

  it("release without waiters restores available", async () => {
    const { Semaphore } = await import("../../src/worker/semaphore.js");
    const sem = new Semaphore(1);
    await sem.acquire();
    expect(sem.available).toBe(0);
    sem.release();
    expect(sem.available).toBe(1);
  });
});
