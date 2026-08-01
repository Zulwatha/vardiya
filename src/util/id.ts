/**
 * Monotonic, lexicographically sortable ids.
 *
 * Format: `{timestampMs in base36}-{counter in base36}-{random}`.
 * The timestamp is zero-padded to a fixed width so string order matches
 * time order. Within a single process, ids generated later always compare
 * greater than earlier ones, even when they share the same millisecond.
 */

let lastTimestamp = 0;
let counter = 0;

/** Enough for unix ms well past year 5000 in base36. */
const TS_WIDTH = 10;
const SEQ_WIDTH = 4;
const RANDOM_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomSuffix(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const idx = Math.floor(Math.random() * RANDOM_ALPHABET.length);
    out += RANDOM_ALPHABET[idx];
  }
  return out;
}

/**
 * Generate a new sortable id. Safe to call from sync code; no I/O.
 *
 * @param now - Optional clock override (unix ms) for tests.
 */
export function createId(now: number = Date.now()): string {
  // Clock moved backwards; keep ordering by bumping from lastTimestamp.
  const tsMs = now < lastTimestamp ? lastTimestamp : now;

  if (tsMs === lastTimestamp) {
    counter += 1;
  } else {
    lastTimestamp = tsMs;
    counter = 0;
  }

  const ts = tsMs.toString(36).padStart(TS_WIDTH, "0");
  const seq = counter.toString(36).padStart(SEQ_WIDTH, "0");
  return `${ts}-${seq}-${randomSuffix(8)}`;
}

/**
 * Reset the internal monotonic state. Intended for tests only.
 */
export function resetIdState(): void {
  lastTimestamp = 0;
  counter = 0;
}
