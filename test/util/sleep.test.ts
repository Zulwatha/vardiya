import { describe, expect, it } from "vitest";
import { sleep } from "../../src/util/sleep.js";

describe("sleep", () => {
  it("resolves after the given delay", async () => {
    const start = Date.now();
    await sleep(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it("rejects when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects when aborted while waiting", async () => {
    const controller = new AbortController();
    const pending = sleep(5000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
