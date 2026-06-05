import { afterEach, describe, expect, test, vi } from "vitest";

const sandboxApi = vi.hoisted(() => ({
  get: vi.fn(),
  getOrCreate: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({ Sandbox: sandboxApi }));

import { VercelProvider } from "../src/sandbox.js";

afterEach(() => {
  vi.useRealTimers();
  sandboxApi.get.mockReset();
  sandboxApi.getOrCreate.mockReset();
});

describe("VercelProvider.stop", () => {
  test("does not accept the previous snapshot id from a running sandbox", async () => {
    vi.useFakeTimers();
    const running = {
      status: "running",
      currentSnapshotId: "snap-old",
      stop: vi.fn(async () => ({ status: "stopped", snapshot: { id: "snap-old" } })),
    };
    const latest = { status: "stopped", currentSnapshotId: "snap-new" };
    sandboxApi.get.mockResolvedValueOnce(running).mockResolvedValueOnce(latest);

    const stopping = new VercelProvider().stop("dev-test");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);

    await expect(stopping).resolves.toEqual({ status: "stopped", snapshotId: "snap-new" });
    expect(running.stop).toHaveBeenCalledTimes(1);
    expect(sandboxApi.get).toHaveBeenCalledTimes(2);
  });

  test("accepts the snapshot returned immediately by an active stop", async () => {
    const running = {
      status: "running",
      currentSnapshotId: "snap-old",
      stop: vi.fn(async () => ({ status: "stopped", snapshot: { id: "snap-new" } })),
    };
    sandboxApi.get.mockResolvedValueOnce(running);

    await expect(new VercelProvider().stop("dev-test")).resolves.toEqual({
      status: "stopped",
      snapshotId: "snap-new",
    });
    expect(sandboxApi.get).toHaveBeenCalledTimes(1);
  });

  test("keeps an existing snapshot when the sandbox was already stopped", async () => {
    const stopped = {
      status: "stopped",
      currentSnapshotId: "snap-existing",
      stop: vi.fn(async () => ({ status: "stopped", snapshot: { id: "snap-existing" } })),
    };
    sandboxApi.get.mockResolvedValueOnce(stopped);

    await expect(new VercelProvider().stop("dev-test")).resolves.toEqual({
      status: "stopped",
      snapshotId: "snap-existing",
    });
    expect(sandboxApi.get).toHaveBeenCalledTimes(1);
  });
});
