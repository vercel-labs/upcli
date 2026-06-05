export interface RetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** Base backoff in ms; doubles each retry. Default 300. */
  baseMs?: number;
  /** Called before each retry (not before the first attempt). */
  onRetry?: (err: unknown, attempt: number) => void;
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
      if (attempt >= attempts) break;
      opts.onRetry?.(err, attempt);
      await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}
