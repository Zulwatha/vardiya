import { unrefTimer } from "./timer.js";

/**
 * Resolve after `ms` milliseconds. Pass an AbortSignal to cancel early;
 * rejection is an `AbortError` DOMException (or Error with name AbortError).
 *
 * The underlying timer is unref'd so an idle sleep alone cannot pin the
 * event loop after the caller has stopped owning work.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    unrefTimer(timer);

    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted", "AbortError");
  }
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}
