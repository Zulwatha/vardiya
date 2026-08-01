import { describe, expect, it } from "vitest";
import { hasCron } from "../helpers/modules.js";

describe.skipIf(!hasCron)("cron nextRun / parseCron", () => {
  it("parses aliases", async () => {
    const { parseCron } = await import("../../src/scheduler/cron.js");
    expect(parseCron("@daily").expression).toBe("0 0 * * *");
    expect(parseCron("@hourly").expression).toBe("0 * * * *");
    expect(parseCron("@weekly").expression).toBe("0 0 * * 0");
    expect(parseCron("@monthly").expression).toBe("0 0 1 * *");
  });

  it("computes next hour boundary", async () => {
    const { nextRun } = await import("../../src/scheduler/cron.js");
    const from = new Date("2024-01-01T10:15:00.000Z");
    expect(nextRun("0 * * * *", from).toISOString()).toBe("2024-01-01T11:00:00.000Z");
  });

  it("handles */10 steps", async () => {
    const { nextRun } = await import("../../src/scheduler/cron.js");
    const from = new Date("2024-01-01T10:05:00.000Z");
    expect(nextRun("*/10 * * * *", from).toISOString()).toBe("2024-01-01T10:10:00.000Z");
  });

  it("skips to next weekday for MON-FRI", async () => {
    const { nextRun } = await import("../../src/scheduler/cron.js");
    // 2024-01-05 is Friday 09:00 UTC; next fire is Monday 09:00.
    const from = new Date("2024-01-05T09:00:00.000Z");
    expect(nextRun("0 9 * * MON-FRI", from).toISOString()).toBe("2024-01-08T09:00:00.000Z");
  });

  it("rolls months for day-of-month schedules", async () => {
    const { nextRun } = await import("../../src/scheduler/cron.js");
    const from = new Date("2024-01-15T00:00:00.000Z");
    expect(nextRun("0 0 1 * *", from).toISOString()).toBe("2024-02-01T00:00:00.000Z");
  });

  it("finds Feb 29 on leap years", async () => {
    const { nextRun } = await import("../../src/scheduler/cron.js");
    const from = new Date("2023-01-01T00:00:00.000Z");
    expect(nextRun("0 0 29 2 *", from).toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });

  it("accepts month names", async () => {
    const { nextRun } = await import("../../src/scheduler/cron.js");
    const from = new Date("2024-06-01T00:00:00.000Z");
    expect(nextRun("0 0 1 JAN *", from).toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  it("rejects empty expressions", async () => {
    const { parseCron } = await import("../../src/scheduler/cron.js");
    expect(() => parseCron("")).toThrow(SyntaxError);
  });
});
