/**
 * Resolve after `ms` milliseconds. Pass an AbortSignal to cancel early;
 * rejection is an `AbortError` DOMException (or Error with name AbortError).
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
