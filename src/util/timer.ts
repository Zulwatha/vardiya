/**
 * Detach a Node timer from the event loop so it cannot keep the process alive.
 * No-op when `unref` is missing (non-Node runtimes).
 */
export function unrefTimer(timer: { unref?: () => unknown } | undefined): void {
  timer?.unref?.();
}
