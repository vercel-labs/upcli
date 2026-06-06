import { describe, expect, test, vi } from "vitest";
import { isRetryableTransport, withRetry } from "../src/retry.js";

describe("withRetry", () => {
  test("returns immediately when the first attempt succeeds", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withRetry(fn, { baseMs: 1 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries transient failures, then succeeds", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 3) throw new Error("transient");
      return "recovered";
    });
    const onRetry = vi.fn();
    expect(await withRetry(fn, { attempts: 3, baseMs: 1, onRetry })).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  test("throws the last error after exhausting all attempts", async () => {
    const fn = vi.fn(async () => {
      throw new Error("still down");
    });
    await expect(withRetry(fn, { attempts: 3, baseMs: 1 })).rejects.toThrow("still down");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("stops immediately when shouldRetry returns false", async () => {
    const fn = vi.fn(async () => {
      throw new Error("fatal");
    });
    await expect(
      withRetry(fn, { attempts: 3, baseMs: 1, shouldRetry: () => false }),
    ).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("keeps retrying while shouldRetry returns true", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 2) throw new Error("retryable");
      return "ok";
    });
    expect(await withRetry(fn, { attempts: 3, baseMs: 1, shouldRetry: () => true })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("isRetryableTransport", () => {
  test("matches the SDK StreamError (dropped command stream)", () => {
    const err = Object.assign(new Error("stream ended early"), { name: "StreamError" });
    expect(isRetryableTransport(err)).toBe(true);
  });

  test("matches request-timeout, rate-limit, and 5xx status codes", () => {
    for (const status of [408, 429, 500, 502, 503]) {
      expect(isRetryableTransport({ response: { status } })).toBe(true);
    }
  });

  test("matches the SDK's malformed-response messages", () => {
    for (const message of [
      "Expected a stream of command data",
      "No response body",
      "Can't parse JSON: SyntaxError: Unexpected non-whitespace character after JSON at position 1",
      "Can't read response text: TypeError: terminated",
    ]) {
      expect(isRetryableTransport(new Error(message))).toBe(true);
    }
  });

  test("does not match aborts, client errors, or ordinary failures", () => {
    expect(isRetryableTransport(new Error("The operation was aborted"))).toBe(false);
    expect(isRetryableTransport({ response: { status: 400 } })).toBe(false);
    expect(isRetryableTransport({ response: { status: 404 } })).toBe(false);
    expect(isRetryableTransport(new Error("`npm install` exited with 1"))).toBe(false);
    expect(isRetryableTransport(undefined)).toBe(false);
    expect(isRetryableTransport(null)).toBe(false);
    expect(isRetryableTransport("string error")).toBe(false);
  });
});
