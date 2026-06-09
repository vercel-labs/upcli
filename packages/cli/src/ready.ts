import { setTimeout as sleep } from "node:timers/promises";
import type { DevSandbox } from "./sandbox.js";

/**
 * Wait until `port` accepts TCP connections inside the sandbox.
 *
 * Uses a bash `/dev/tcp` probe because `lsof`/`ss` are unreliable in the
 * sandbox (ports are virtualized). Polls every 100ms up to `timeoutMs`.
 * Returns true once the port is open, false on timeout.
 */
export async function waitForPort(
  sandbox: DevSandbox,
  port: number,
  timeoutMs = 90_000,
  signal?: AbortSignal,
): Promise<boolean> {
  const iterations = Math.ceil(timeoutMs / 100);
  // Pass the loop count and port as positional arguments ($1/$2) rather than
  // interpolating them into the script, matching the rest of the codebase.
  const script =
    'for i in $(seq 1 "$1"); do (echo > "/dev/tcp/127.0.0.1/$2") 2>/dev/null && exit 0; sleep 0.1; done; exit 1';
  const { exitCode } = await sandbox.exec(
    "bash",
    ["-c", script, "waitForPort", String(iterations), String(port)],
    { signal, retryTransport: true },
  );
  return exitCode === 0;
}

/**
 * Wait until the supervisor answering on the public `url` reports our `runId`.
 * Confirms the supervisor we just launched (not a stale/orphaned one from a
 * previous run) is the one serving the public path, before we hand out the URL.
 * Returns false on timeout.
 */
export async function waitForSupervisor(
  url: string,
  runId: string,
  timeoutMs = 20_000,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/__dev/status`, { signal });
      if (res.ok) {
        const data = (await res.json()) as { runId?: string };
        if (data.runId === runId) return true;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
    await sleep(400, undefined, { signal });
  }
  return false;
}
