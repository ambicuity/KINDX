/**
 * fetch-with-timeout.ts
 *
 * Wraps `fetch()` with a hard timeout via AbortSignal. Required because:
 *   - Node's fetch has no built-in socket timeout — a hung remote (Ollama
 *     deadlocked, network blackhole) keeps the request open forever.
 *   - Combined with the bounded LLM pool, one hung upstream pins all leases
 *     and the daemon stops serving requests.
 *
 * Merges a caller-provided AbortSignal with the timeout signal so callers can
 * still cancel manually (e.g. on session disconnect).
 */

export type FetchWithTimeoutInit = RequestInit & {
  /** Per-request hard timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
};

export class FetchTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly url: string;
  constructor(url: string, timeoutMs: number) {
    super(`fetch timed out after ${timeoutMs}ms: ${url}`);
    this.name = "FetchTimeoutError";
    this.timeoutMs = timeoutMs;
    this.url = url;
  }
}

/**
 * Like `fetch(input, init)` but aborts after `timeoutMs` (default 30000).
 *
 * If the caller passes their own `signal`, the request aborts when *either*
 * signal fires. The original signal's reason is preserved on caller-side abort;
 * a timeout abort throws `FetchTimeoutError`.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: FetchWithTimeoutInit = {}
): Promise<Response> {
  const { timeoutMs = 30000, signal: callerSignal, ...rest } = init;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new FetchTimeoutError(String(input), timeoutMs)), timeoutMs);

  // Forward caller abort -> our controller (so the fetch sees a single signal).
  let onCallerAbort: (() => void) | null = null;
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timer);
      throw callerSignal.reason ?? new DOMException("Aborted", "AbortError");
    }
    onCallerAbort = () => controller.abort(callerSignal.reason);
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  try {
    return await fetch(input, { ...rest, signal: controller.signal });
  } catch (err) {
    // Distinguish timeout from caller-cancel by checking the abort reason.
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof FetchTimeoutError) throw reason;
      // Caller-initiated abort: propagate the original reason.
      throw reason ?? err;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (callerSignal && onCallerAbort) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }
}
