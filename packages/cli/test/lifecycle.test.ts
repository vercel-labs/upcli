import { describe, expect, test, vi } from "vitest";
import { SandboxLifecycle } from "../src/lifecycle.js";
import type { DevSandbox, RunningProcess } from "../src/sandbox.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sandboxWithStop(snapshotId = "snap-1") {
  const stop = vi.fn(async () => ({ status: "stopped", snapshotId }));
  return { sandbox: { stop } as unknown as DevSandbox, stop };
}

function processWithKill(): { process: RunningProcess; kill: ReturnType<typeof vi.fn> } {
  const kill = vi.fn(async () => {});
  return {
    process: { kill } as unknown as RunningProcess,
    kill,
  };
}

describe("SandboxLifecycle", () => {
  test("kills child processes, waits for active work and verifies the saved snapshot", async () => {
    const { sandbox, stop } = sandboxWithStop();
    const resources = new SandboxLifecycle(sandbox);
    const { process, kill } = processWithKill();
    const active = deferred<void>();
    resources.addProcess(process);
    const tracked = resources.run(() => active.promise).catch(() => undefined);

    const shutdown = resources.shutdown();
    await Promise.resolve();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(stop).not.toHaveBeenCalled();

    active.resolve();
    await tracked;
    await expect(shutdown).resolves.toEqual({ status: "stopped", snapshotId: "snap-1" });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("shutdown is idempotent across repeated stop requests", async () => {
    const { sandbox, stop } = sandboxWithStop();
    const resources = new SandboxLifecycle(sandbox);
    await Promise.all([resources.shutdown(), resources.shutdown(), resources.shutdown()]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("still saves a snapshot after a tracked boot operation fails", async () => {
    const { sandbox, stop } = sandboxWithStop("snap-after-error");
    const resources = new SandboxLifecycle(sandbox);
    await expect(resources.run(() => Promise.reject(new Error("install failed")))).rejects.toThrow(
      "install failed",
    );
    await expect(resources.shutdown()).resolves.toMatchObject({ snapshotId: "snap-after-error" });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("rejects shutdown when persistence did not yield a snapshot", async () => {
    const { sandbox } = sandboxWithStop("");
    const resources = new SandboxLifecycle(sandbox);
    await expect(resources.shutdown()).rejects.toThrow("without returning a snapshot id");
  });

  test("aborts cancellable work when shutdown begins", async () => {
    const { sandbox } = sandboxWithStop();
    const resources = new SandboxLifecycle(sandbox);
    const active = resources
      .run(
        (signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      )
      .catch((err: unknown) => err);

    await expect(resources.shutdown()).resolves.toMatchObject({ snapshotId: "snap-1" });
    await expect(active).resolves.toBeInstanceOf(Error);
  });

  test("does not start work after shutdown has been requested", async () => {
    const { sandbox } = sandboxWithStop();
    const resources = new SandboxLifecycle(sandbox);
    await resources.shutdown();
    const start = vi.fn(async () => undefined);
    await expect(resources.run(start)).rejects.toThrow("Sandbox shutdown requested");
    expect(start).not.toHaveBeenCalled();
  });

  test("can hand off stopping after cancelling active work", async () => {
    const { sandbox, stop } = sandboxWithStop();
    const resources = new SandboxLifecycle(sandbox);
    const active = resources
      .run(
        (signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      )
      .catch((err: unknown) => err);

    resources.cancelWork();
    await expect(active).resolves.toBeInstanceOf(Error);
    await expect(resources.run(async () => undefined)).rejects.toThrow(
      "Sandbox shutdown requested",
    );
    expect(stop).not.toHaveBeenCalled();
  });
});
