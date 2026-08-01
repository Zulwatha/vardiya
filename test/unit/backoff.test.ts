import { afterEach, describe, expect, it, vi } from "vitest";
import { computeBackoffMs } from "../../src/storage/sqlite.js";

describe("computeBackoffMs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses fixed delay", () => {
    expect(computeBackoffMs({ type: "fixed", delayMs: 250 }, 1)).toBe(250);
    expect(computeBackoffMs({ type: "fixed", delayMs: 250 }, 5)).toBe(250);
  });

  it("grows exponentially as delayMs * 2^(attempt - 1)", () => {
    const opts = { type: "exponential" as const, delayMs: 1000 };
    expect(computeBackoffMs(opts, 1)).toBe(1000);
    expect(computeBackoffMs(opts, 2)).toBe(2000);
    expect(computeBackoffMs(opts, 3)).toBe(4000);
    expect(computeBackoffMs(opts, 4)).toBe(8000);
  });

  it("caps exponential growth at maxDelayMs", () => {
    const delay = computeBackoffMs({ type: "exponential", delayMs: 1000, maxDelayMs: 3000 }, 10);
    expect(delay).toBe(3000);
  });

  it("applies full jitter in [0, delay]", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const delay = computeBackoffMs({ type: "exponential", delayMs: 1000, jitter: true }, 1);
    // floor(0.5 * (1000 + 1)) = 500
    expect(delay).toBe(500);
  });

  it("treats attempt < 1 as attempt 1", () => {
    expect(computeBackoffMs({ type: "exponential", delayMs: 100 }, 0)).toBe(100);
  });
});
