/**
 * Run cleanup callbacks in LIFO order, awaiting each one.
 * Use from afterEach so workers/storage always drain before the next test.
 */
export async function runCleanups(cleanups: Array<() => void | Promise<void>>): Promise<void> {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) {
      await fn();
    }
  }
}
