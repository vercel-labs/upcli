import type { DevSandbox, RunningProcess } from "./sandbox.js";

export interface Closeable {
  close(): Promise<void>;
}

export interface SavedSnapshot {
  snapshotId: string;
  status?: string;
}

/**
 * Owns all resources created after a sandbox exists. Shutdown is idempotent:
 * stop known child processes, stop producing new work, wait for in-flight
 * operations, then stop the persistent sandbox and require its snapshot id.
 */
export class SandboxLifecycle {
  private readonly processes = new Set<RunningProcess>();
  private readonly closeables = new Set<Closeable>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly abortController = new AbortController();
  private cancelled = false;
  private shutdownPromise: Promise<SavedSnapshot> | undefined;

  constructor(private readonly sandbox: DevSandbox) {}

  get shuttingDown(): boolean {
    return this.cancelled || this.shutdownPromise !== undefined;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  addProcess(proc: RunningProcess): void {
    this.processes.add(proc);
  }

  removeProcess(proc: RunningProcess): void {
    this.processes.delete(proc);
  }

  addCloseable(closeable: Closeable): void {
    this.closeables.add(closeable);
  }

  /** Run sandbox work that must settle before the final snapshot is saved. */
  async run<T>(start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.shuttingDown) throw new Error("Sandbox shutdown requested.");
    const operation = start(this.abortController.signal);
    this.operations.add(operation);
    try {
      const result = await operation;
      if (this.shuttingDown) throw new Error("Sandbox shutdown requested.");
      return result;
    } finally {
      this.operations.delete(operation);
    }
  }

  /** Prevent new work and abort cancellable I/O before another process takes over stop. */
  cancelWork(): void {
    this.cancelled = true;
    this.abortController.abort();
  }

  shutdown(): Promise<SavedSnapshot> {
    this.cancelWork();
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.performShutdown();
    }
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<SavedSnapshot> {
    await Promise.allSettled([...this.closeables].map((resource) => resource.close()));
    await Promise.allSettled([...this.processes].map((proc) => proc.kill("SIGTERM")));
    await Promise.allSettled([...this.operations]);

    const stopped = await this.sandbox.stop();
    if (!stopped.snapshotId) {
      throw new Error(
        `stop() completed without returning a snapshot id (status: ${stopped.status ?? "unknown"})`,
      );
    }
    return { status: stopped.status, snapshotId: stopped.snapshotId };
  }
}
