import { afterEach, describe, expect, it } from "vitest";
import { createId, resetIdState } from "../../src/util/id.js";

afterEach(() => {
  resetIdState();
});

describe("createId", () => {
  it("returns a three-part id", () => {
    const id = createId(1_700_000_000_000);
    const parts = id.split("-");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe((1_700_000_000_000).toString(36).padStart(10, "0"));
    expect(parts[1]).toBe("0000");
    expect(parts[2]).toMatch(/^[0-9a-z]{8}$/);
  });

  it("is lexicographically sortable within the same millisecond", () => {
    const a = createId(1000);
    const b = createId(1000);
    const c = createId(1000);
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it("advances with time", () => {
    const earlier = createId(1000);
    const later = createId(2000);
    expect(earlier < later).toBe(true);
  });

  it("stays monotonic when the clock moves backwards", () => {
    const a = createId(5000);
    const b = createId(1000);
    expect(a < b).toBe(true);
  });
});
