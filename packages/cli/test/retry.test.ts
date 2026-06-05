import { describe, expect, test, vi } from "vitest";
import { withRetry } from "../src/retry.js";

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
});
