/**
 * Cron next-run self-check. Not part of the public package surface.
 *
 * Run: npx tsx src/scheduler/selfcheck.ts
 * Exits 0 on success, 1 on the first failing assertion.
 */

import assert from "node:assert/strict";
import { nextRun, parseCron } from "./cron.js";

interface Case {
  expr: string;
  from: string;
  expected: string;
  note?: string;
}

const cases: Case[] = [
  {
    expr: "0 * * * *",
    from: "2024-01-01T10:15:00.000Z",
    expected: "2024-01-01T11:00:00.000Z",
    note: "top of next hour",
  },
  {
    expr: "*/10 * * * *",
    from: "2024-01-01T10:05:00.000Z",
    expected: "2024-01-01T10:10:00.000Z",
    note: "step minutes",
  },
  {
    expr: "*/10 * * * *",
    from: "2024-01-01T10:10:00.000Z",
    expected: "2024-01-01T10:20:00.000Z",
    note: "step minutes exclusive of from",
  },
  {
    expr: "0 9 * * MON-FRI",
    from: "2024-01-05T09:00:00.000Z",
    expected: "2024-01-08T09:00:00.000Z",
    note: "Friday 09:00 -> Monday 09:00",
  },
  {
    expr: "0 9 * * MON-FRI",
    from: "2024-01-08T08:59:00.000Z",
    expected: "2024-01-08T09:00:00.000Z",
    note: "weekday same morning",
  },
  {
    expr: "0 0 1 * *",
    from: "2024-01-15T00:00:00.000Z",
    expected: "2024-02-01T00:00:00.000Z",
    note: "month rollover",
  },
  {
    expr: "0 0 1 * *",
    from: "2024-12-01T00:00:00.000Z",
    expected: "2025-01-01T00:00:00.000Z",
    note: "year rollover on first-of-month",
  },
  {
    expr: "0 0 29 2 *",
    from: "2023-01-01T00:00:00.000Z",
    expected: "2024-02-29T00:00:00.000Z",
    note: "Feb 29 next leap year",
  },
  {
    expr: "0 0 29 2 *",
    from: "2024-02-29T00:00:00.000Z",
    expected: "2028-02-29T00:00:00.000Z",
    note: "Feb 29 after a leap day",
  },
  {
    expr: "@daily",
    from: "2024-06-01T12:00:00.000Z",
    expected: "2024-06-02T00:00:00.000Z",
  },
  {
    expr: "@hourly",
    from: "2024-06-01T12:30:00.000Z",
    expected: "2024-06-01T13:00:00.000Z",
  },
  {
    expr: "@weekly",
    from: "2024-06-01T00:00:00.000Z",
    expected: "2024-06-02T00:00:00.000Z",
    note: "Saturday -> Sunday midnight",
  },
  {
    expr: "@monthly",
    from: "2024-06-15T00:00:00.000Z",
    expected: "2024-07-01T00:00:00.000Z",
  },
  {
    expr: "0 0 1 JAN *",
    from: "2024-06-01T00:00:00.000Z",
    expected: "2025-01-01T00:00:00.000Z",
    note: "month name",
  },
  {
    expr: "15,45 * * * *",
    from: "2024-01-01T10:15:00.000Z",
    expected: "2024-01-01T10:45:00.000Z",
    note: "minute list",
  },
  {
    expr: "0 0 * * 0",
    from: "2024-01-01T00:00:00.000Z",
    expected: "2024-01-07T00:00:00.000Z",
    note: "next Sunday",
  },
  {
    expr: "0 0 * * SUN",
    from: "2024-01-03T00:00:00.000Z",
    expected: "2024-01-07T00:00:00.000Z",
    note: "dow name",
  },
  {
    expr: "5 4 * * *",
    from: "2024-01-01T04:05:00.000Z",
    expected: "2024-01-02T04:05:00.000Z",
  },
  {
    expr: "0-5 * * * *",
    from: "2024-01-01T10:05:00.000Z",
    expected: "2024-01-01T11:00:00.000Z",
    note: "minute range wraps hour",
  },
  {
    expr: "1-10/3 * * * *",
    from: "2024-01-01T10:01:00.000Z",
    expected: "2024-01-01T10:04:00.000Z",
    note: "range with step",
  },
  {
    expr: "0 8-10 * * *",
    from: "2024-01-01T10:00:00.000Z",
    expected: "2024-01-02T08:00:00.000Z",
    note: "hour range wraps day",
  },
  {
    expr: "0 0 1 JAN,JUL *",
    from: "2024-03-01T00:00:00.000Z",
    expected: "2024-07-01T00:00:00.000Z",
    note: "month list",
  },
  {
    expr: "30 4 1,15 * *",
    from: "2024-01-01T04:30:00.000Z",
    expected: "2024-01-15T04:30:00.000Z",
    note: "dom list",
  },
  {
    expr: "0 0 1 * MON",
    from: "2024-01-01T00:00:00.000Z",
    expected: "2024-01-08T00:00:00.000Z",
    note: "dom OR dow (next Monday)",
  },
  {
    expr: "59 23 31 12 *",
    from: "2024-12-31T23:59:00.000Z",
    expected: "2025-12-31T23:59:00.000Z",
    note: "last minute of year",
  },
  {
    expr: "0 0 * 2 *",
    from: "2024-02-28T00:00:00.000Z",
    expected: "2024-02-29T00:00:00.000Z",
    note: "leap day inside February-only schedule",
  },
  {
    expr: "0 0 * 2 *",
    from: "2024-02-29T00:00:00.000Z",
    expected: "2025-02-01T00:00:00.000Z",
    note: "after leap day, next Feb",
  },
  {
    expr: "0 12 1 1 *",
    from: "2024-01-01T12:00:00.000Z",
    expected: "2025-01-01T12:00:00.000Z",
  },
  {
    expr: "0 0 * * FRI",
    from: "2024-01-05T00:00:00.000Z",
    expected: "2024-01-12T00:00:00.000Z",
  },
  {
    expr: "*/15 0 * * *",
    from: "2024-01-01T00:00:00.000Z",
    expected: "2024-01-01T00:15:00.000Z",
  },
  {
    expr: "0 0 31 1 *",
    from: "2024-01-31T00:00:00.000Z",
    expected: "2025-01-31T00:00:00.000Z",
    note: "Jan 31 annually",
  },
];

function iso(d: Date): string {
  return d.toISOString();
}

function run(): void {
  assert.ok(cases.length >= 25, `expected >= 25 cases, got ${cases.length}`);

  let i = 0;
  for (const c of cases) {
    i += 1;
    const got = nextRun(c.expr, new Date(c.from));
    assert.equal(
      iso(got),
      c.expected,
      `case ${i} (${c.note ?? c.expr}): nextRun(${JSON.stringify(c.expr)}, ${c.from})`,
    );
  }

  // parseCron basics
  const hourly = parseCron("@hourly");
  assert.deepEqual(hourly.minutes, [0]);
  assert.equal(hourly.hours.length, 24);

  const stepped = parseCron("*/10 * * * *");
  assert.deepEqual(stepped.minutes, [0, 10, 20, 30, 40, 50]);

  const named = parseCron("0 0 1 JAN MON");
  assert.deepEqual(named.months, [1]);
  assert.deepEqual(named.dows, [1]);

  // Invalid input
  assert.throws(() => parseCron(""), SyntaxError);
  assert.throws(() => parseCron("0 0 0 0"), SyntaxError);
  assert.throws(() => parseCron("60 * * * *"), SyntaxError);
  assert.throws(() => nextRun("0 * * * *", new Date(Number.NaN)), RangeError);

  // Sub-second from still advances to a later minute slot
  const sub = nextRun("0 * * * *", new Date("2024-01-01T10:00:00.500Z"));
  assert.equal(iso(sub), "2024-01-01T11:00:00.000Z");

  console.log(`scheduler selfcheck ok: ${cases.length} nextRun cases + parse guards`);
}

run();
