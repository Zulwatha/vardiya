/**
 * Dependency-free 5-field cron parser and next-run calculator.
 *
 * All arithmetic is in UTC so DST transitions never shift fire times. Pass a
 * Date (any timezone) into {@link nextRun}; the returned Date is the next
 * matching UTC instant strictly after `from`.
 *
 * Format: `minute hour day-of-month month day-of-week`
 *
 * | Expression         | Meaning                              | from (UTC)           | next (UTC)           |
 * |--------------------|--------------------------------------|----------------------|----------------------|
 * | 0 * * * *          | top of every hour                    | 2024-01-01T10:15:00Z | 2024-01-01T11:00:00Z |
 * | star/10 * * * *    | every 10 minutes (star = asterisk)   | 2024-01-01T10:05:00Z | 2024-01-01T10:10:00Z |
 * | 0 9 * * MON-FRI    | 09:00 on weekdays                    | 2024-01-05T09:00:00Z | 2024-01-08T09:00:00Z |
 * | 0 0 1 * *          | midnight on the 1st (month rollover) | 2024-01-15T00:00:00Z | 2024-02-01T00:00:00Z |
 * | 0 0 29 2 *         | Feb 29 only (leap years)             | 2023-01-01T00:00:00Z | 2024-02-29T00:00:00Z |
 * | @daily             | alias for 0 0 * * *                  | 2024-06-01T12:00:00Z | 2024-06-02T00:00:00Z |
 * | 0 0 1 JAN *        | midnight Jan 1                       | 2024-06-01T00:00:00Z | 2025-01-01T00:00:00Z |
 *
 * Supported syntax per field: asterisk (any), n, a-b (range), a-b/s or
 * asterisk/s (step), comma lists, and names for month (JAN..DEC) and
 * day-of-week (SUN..SAT). Day-of-week accepts 0-7 where 0 and 7 are Sunday.
 *
 * Note: the asterisk-slash sequence cannot appear literally in this block
 * comment (it would terminate the comment), so the table spells it out.
 *
 * Aliases: `@hourly`, `@daily`, `@weekly`, `@monthly`.
 *
 * Day-of-month vs day-of-week: when both are constrained (neither is `*`), a
 * date matches if either field matches (Vixie cron OR semantics). When one is
 * `*`, only the other field restricts the day.
 */

const MINUTE = { min: 0, max: 59 } as const;
const HOUR = { min: 0, max: 23 } as const;
const DOM = { min: 1, max: 31 } as const;
const MONTH = { min: 1, max: 12 } as const;
const DOW = { min: 0, max: 7 } as const;

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const DOW_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

/** Parsed schedule: sorted unique allowed values per field. */
export interface CronSchedule {
  minutes: number[];
  hours: number[];
  doms: number[];
  months: number[];
  dows: number[];
  /** True when the day-of-month field was `*` (unrestricted). */
  domAny: boolean;
  /** True when the day-of-week field was `*` (unrestricted). */
  dowAny: boolean;
  /** Original expression after alias expansion. */
  expression: string;
}

/**
 * Parse a 5-field cron expression (or alias) into a {@link CronSchedule}.
 * Throws {@link SyntaxError} on invalid input.
 */
export function parseCron(expr: string): CronSchedule {
  const trimmed = expr.trim();
  if (trimmed.length === 0) {
    throw new SyntaxError("cron expression is empty");
  }

  const expanded = ALIASES[trimmed.toLowerCase()] ?? trimmed;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) {
    throw new SyntaxError(`cron expression must have 5 fields (got ${fields.length}): ${expr}`);
  }

  const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string];

  const domAny = domF === "*";
  const dowAny = dowF === "*";

  const minutes = parseField(minF, MINUTE, undefined);
  const hours = parseField(hourF, HOUR, undefined);
  const doms = parseField(domF, DOM, undefined);
  const months = parseField(monF, MONTH, MONTH_NAMES);
  // Normalize 7 (Sunday) to 0 so membership checks use getUTCDay() directly.
  const rawDows = parseField(dowF, DOW, DOW_NAMES);
  const dowSet = new Set<number>();
  for (const d of rawDows) {
    dowSet.add(d === 7 ? 0 : d);
  }
  const dows = [...dowSet].sort((a, b) => a - b);

  return {
    minutes,
    hours,
    doms,
    months,
    dows,
    domAny,
    dowAny,
    expression: expanded,
  };
}

/**
 * Return the next Date strictly after `from` that matches `expr`.
 * Computation uses UTC fields exclusively (DST-safe).
 */
export function nextRun(expr: string | CronSchedule, from: Date): Date {
  const schedule = typeof expr === "string" ? parseCron(expr) : expr;
  if (Number.isNaN(from.getTime())) {
    throw new RangeError("from is an invalid Date");
  }

  // Start at the beginning of the next UTC minute after `from`.
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  // Hard cap: never scan more than ~5 years of candidate days.
  const deadline = from.getTime() + 5 * 366 * 24 * 60 * 60 * 1000;

  while (cursor.getTime() <= deadline) {
    const month = cursor.getUTCMonth() + 1; // 1-12
    if (!schedule.months.includes(month)) {
      // Jump to the 1st of the next allowed month (or next year).
      advanceToNextMonth(cursor, schedule.months);
      continue;
    }

    const day = cursor.getUTCDate();
    const dow = cursor.getUTCDay(); // 0=Sun
    if (!dayMatches(schedule, day, dow)) {
      advanceOneDay(cursor);
      continue;
    }

    const hour = cursor.getUTCHours();
    if (!schedule.hours.includes(hour)) {
      advanceToNextHour(cursor, schedule.hours);
      continue;
    }

    const minute = cursor.getUTCMinutes();
    if (!schedule.minutes.includes(minute)) {
      advanceToNextMinute(cursor, schedule.minutes);
      continue;
    }

    return cursor;
  }

  throw new RangeError(`no next run within 5 years for cron: ${schedule.expression}`);
}

function dayMatches(schedule: CronSchedule, dom: number, dow: number): boolean {
  const domOk = schedule.doms.includes(dom);
  const dowOk = schedule.dows.includes(dow);

  if (schedule.domAny && schedule.dowAny) return true;
  if (schedule.domAny) return dowOk;
  if (schedule.dowAny) return domOk;
  // Both constrained: OR semantics (Vixie).
  return domOk || dowOk;
}

function advanceOneDay(cursor: Date): void {
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  cursor.setUTCHours(0, 0, 0, 0);
}

function advanceToNextMonth(cursor: Date, months: number[]): void {
  // Try remaining months this year, then wrap.
  const year = cursor.getUTCFullYear();
  const currentMonth = cursor.getUTCMonth() + 1;
  for (const m of months) {
    if (m > currentMonth) {
      cursor.setUTCFullYear(year, m - 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      return;
    }
  }
  const first = months[0];
  if (first === undefined) {
    throw new RangeError("cron month set is empty");
  }
  cursor.setUTCFullYear(year + 1, first - 1, 1);
  cursor.setUTCHours(0, 0, 0, 0);
}

function advanceToNextHour(cursor: Date, hours: number[]): void {
  const current = cursor.getUTCHours();
  for (const h of hours) {
    if (h > current) {
      cursor.setUTCHours(h, 0, 0, 0);
      return;
    }
  }
  // Next day, first allowed hour.
  advanceOneDay(cursor);
  const first = hours[0];
  if (first === undefined) {
    throw new RangeError("cron hour set is empty");
  }
  cursor.setUTCHours(first, 0, 0, 0);
}

function advanceToNextMinute(cursor: Date, minutes: number[]): void {
  const current = cursor.getUTCMinutes();
  for (const m of minutes) {
    if (m > current) {
      cursor.setUTCMinutes(m, 0, 0);
      return;
    }
  }
  // Roll to next hour; minute selection happens on the next loop iteration.
  cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
}

interface FieldBounds {
  min: number;
  max: number;
}

/**
 * Expand one cron field into a sorted list of allowed integers.
 */
function parseField(
  field: string,
  bounds: FieldBounds,
  names: Record<string, number> | undefined,
): number[] {
  if (field === "*") {
    return range(bounds.min, bounds.max);
  }

  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part.length === 0) {
      throw new SyntaxError(`empty list item in cron field: ${field}`);
    }
    for (const n of parsePart(part, bounds, names)) {
      values.add(n);
    }
  }

  if (values.size === 0) {
    throw new SyntaxError(`cron field matches nothing: ${field}`);
  }

  return [...values].sort((a, b) => a - b);
}

function parsePart(
  part: string,
  bounds: FieldBounds,
  names: Record<string, number> | undefined,
): number[] {
  // split step: base/step
  const slash = part.indexOf("/");
  let base: string;
  let step = 1;
  if (slash >= 0) {
    base = part.slice(0, slash);
    const stepStr = part.slice(slash + 1);
    step = parseIntDecimal(stepStr);
    if (step <= 0) {
      throw new SyntaxError(`cron step must be positive: ${part}`);
    }
    if (base.length === 0) {
      throw new SyntaxError(`cron step missing base: ${part}`);
    }
  } else {
    base = part;
  }

  let start: number;
  let end: number;

  if (base === "*") {
    start = bounds.min;
    end = bounds.max;
  } else if (base.includes("-")) {
    const dash = base.indexOf("-");
    start = parseToken(base.slice(0, dash), bounds, names);
    end = parseToken(base.slice(dash + 1), bounds, names);
    if (start > end) {
      throw new SyntaxError(`cron range start > end: ${part}`);
    }
  } else {
    // Single value. With a step, treat as start..max (common cron extension).
    start = parseToken(base, bounds, names);
    end = slash >= 0 ? bounds.max : start;
  }

  const out: number[] = [];
  for (let n = start; n <= end; n += step) {
    out.push(n);
  }
  return out;
}

function parseToken(
  token: string,
  bounds: FieldBounds,
  names: Record<string, number> | undefined,
): number {
  const upper = token.toUpperCase();
  if (names !== undefined && upper in names) {
    const named = names[upper];
    if (named === undefined) {
      throw new SyntaxError(`unknown cron name: ${token}`);
    }
    return named;
  }
  const n = parseIntDecimal(token);
  if (n < bounds.min || n > bounds.max) {
    throw new SyntaxError(`cron value ${n} out of range [${bounds.min}, ${bounds.max}]`);
  }
  return n;
}

function parseIntDecimal(s: string): number {
  if (!/^\d+$/.test(s)) {
    throw new SyntaxError(`invalid cron number: ${s}`);
  }
  return Number(s);
}

function range(min: number, max: number): number[] {
  const out: number[] = [];
  for (let i = min; i <= max; i++) out.push(i);
  return out;
}
