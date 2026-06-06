export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** Base backoff in ms; doubles each retry. Default 300. */
  baseMs?: number;
  /** Called before each retry (not before the first attempt). */
  onRetry?: (err: unknown, attempt: number) => void;
  /**
   * Gate retries on the error: an error that does not match is rethrown
   * immediately without further attempts. Defaults to retrying any error.
   */
  shouldRetry?: (err: unknown) => boolean;
}

/**
 * Run `fn`, retrying on rejection with exponential backoff. Meant for transient
 * network failures talking to the sandbox; only wrap idempotent operations
 * (writeFiles, extendTimeout), never commands with side effects that must run
 * exactly once. Rethrows the last error if every attempt fails.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 300;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || (opts.shouldRetry && !opts.shouldRetry(err))) break;
      opts.onRetry?.(err, attempt);
      await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

/**
 * True for transport/infrastructure failures that are safe to retry on
 * idempotent operations: dropped command streams, request timeouts, rate limits,
 * 5xx, and the 2xx-but-malformed responses the Sandbox SDK reports when a proxy
 * or gateway mangles a streaming/JSON response. Excludes aborts and ordinary
 * application errors so a genuine failure is never masked by retries.
 */
export function isRetryableTransport(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  // SDK StreamError: the command stream ended before data or finish arrived.
  if ((err as { name?: string }).name === "StreamError") return true;
  const status = (err as { response?: { status?: number } }).response?.status;
  if (typeof status === "number" && (status === 408 || status === 429 || status >= 500)) {
    return true;
  }
  const message = err instanceof Error ? err.message : "";
  return /Expected a stream of command data|No response body|Can't (parse JSON|read response text)/.test(
    message,
  );
}
