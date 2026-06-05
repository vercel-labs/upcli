import { Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { Sandbox } from "@vercel/sandbox";
import type { Credentials } from "./auth.js";
import { withRetry } from "./retry.js";

export interface DevFile {
  /** Path relative to the project root inside the sandbox, or absolute. */
  path: string;
  content: string | Uint8Array;
  mode?: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  sudo?: boolean;
  /** Called with each chunk of combined stdout/stderr output. */
  onLog?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
}

export interface RunningProcess {
  logs(): AsyncIterable<{ stream: "stdout" | "stderr"; data: string }>;
  wait(signal?: AbortSignal): Promise<ExecResult>;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

export interface StopResult {
  status?: string;
  snapshotId?: string;
}

/** Sandbox operations used by the CLI and its test doubles. */
export interface DevSandbox {
  readonly name: string;
  writeFiles(files: DevFile[]): Promise<void>;
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  spawn(cmd: string, args: string[], opts?: ExecOptions): Promise<RunningProcess>;
  domain(port: number): string;
  /** Add `durationMs` to the sandbox's remaining lifetime (capped by the plan). */
  extendTimeout(durationMs: number): Promise<void>;
  /** The running session ID; changes when the SDK auto-resumes after a stop. */
  sessionId(): string;
  stop(): Promise<StopResult>;
}

export interface GetOrCreateOptions {
  name: string;
  credentials?: Credentials;
  ports: number[];
  timeoutMs: number;
  vcpus?: number;
  runtime?: string;
  env?: Record<string, string>;
  /** Runs once, only on fresh creation. */
  onCreate?: () => Promise<void> | void;
  /** Runs on every resume of a stopped persistent sandbox. */
  onResume?: () => Promise<void> | void;
  signal?: AbortSignal;
}

export interface SandboxProvider {
  getOrCreate(opts: GetOrCreateOptions): Promise<DevSandbox>;
  /** Stop a sandbox by name and return its persisted snapshot. */
  stop(name: string, credentials?: Credentials): Promise<StopResult>;
}

function writableForLog(onLog: (chunk: string) => void): Writable {
  return new Writable({
    write(chunk, _enc, cb) {
      onLog(chunk.toString());
      cb();
    },
  });
}

class VercelDevSandbox implements DevSandbox {
  constructor(
    readonly name: string,
    private sandbox: Sandbox,
    private readonly credentials?: Credentials,
  ) {}

  async writeFiles(files: DevFile[]): Promise<void> {
    // Idempotent, so safe to retry through transient network blips.
    await withRetry(() => this.sandbox.writeFiles(files));
  }

  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const stream = opts.onLog ? writableForLog(opts.onLog) : undefined;
    const finished = await this.sandbox.runCommand({
      cmd,
      args,
      cwd: opts.cwd,
      env: opts.env,
      sudo: opts.sudo,
      signal: opts.signal,
      stdout: stream,
      stderr: stream,
    });
    return { exitCode: finished.exitCode };
  }

  async spawn(cmd: string, args: string[], opts: ExecOptions = {}): Promise<RunningProcess> {
    const command = await this.sandbox.runCommand({
      cmd,
      args,
      cwd: opts.cwd,
      env: opts.env,
      sudo: opts.sudo,
      signal: opts.signal,
      detached: true,
    });
    return {
      logs: () => command.logs(),
      wait: async (signal) => {
        const finished = await command.wait({ signal });
        return { exitCode: finished.exitCode };
      },
      kill: (signal) => command.kill(signal as never).then(() => undefined),
    };
  }

  domain(port: number): string {
    return this.sandbox.domain(port);
  }

  async extendTimeout(durationMs: number): Promise<void> {
    await withRetry(() => this.sandbox.extendTimeout(durationMs));
  }

  sessionId(): string {
    return this.sandbox.currentSession().sessionId;
  }

  async stop(): Promise<StopResult> {
    const beforeSnapshotId = this.sandbox.currentSnapshotId;
    const wasStopped = this.sandbox.status === "stopped";
    const isNewSnapshot = (snapshotId: string | undefined): snapshotId is string =>
      Boolean(snapshotId && (!beforeSnapshotId || snapshotId !== beforeSnapshotId));
    const stopped = await this.sandbox.stop();
    const snapshotId = stopped.snapshot?.id;
    if (snapshotId && (wasStopped || isNewSnapshot(snapshotId))) {
      return { status: stopped.status, snapshotId };
    }

    // A stopped session can expose its snapshot pointer shortly after stop resolves.
    const deadline = Date.now() + 60_000;
    let last: { status?: string; snapshotId?: string } = {
      status: stopped.status,
      snapshotId: this.sandbox.currentSnapshotId,
    };
    while (Date.now() < deadline) {
      await sleep(1000);
      const latest = await withRetry(() =>
        Sandbox.get({
          name: this.name,
          resume: false,
          ...(this.credentials ?? {}),
        }),
      );
      this.sandbox = latest;
      last = { status: latest.status, snapshotId: latest.currentSnapshotId };
      if (wasStopped && last.snapshotId) return last;
      if (last.status === "stopped" && isNewSnapshot(last.snapshotId)) {
        return last;
      }
    }
    return wasStopped && last.snapshotId ? last : { status: last.status };
  }
}

/** Default sandbox lifetime. Extended periodically while the CLI is attached. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class VercelProvider implements SandboxProvider {
  async getOrCreate(opts: GetOrCreateOptions): Promise<DevSandbox> {
    const wrap = (raw: Sandbox) => new VercelDevSandbox(opts.name, raw, opts.credentials);
    // Captured so the callbacks below narrow to defined without a non-null assertion.
    const { onCreate, onResume } = opts;

    const sandbox = await Sandbox.getOrCreate({
      name: opts.name,
      ports: opts.ports,
      timeout: opts.timeoutMs,
      runtime: opts.runtime ?? "node24",
      resources: opts.vcpus ? { vcpus: opts.vcpus } : undefined,
      env: opts.env,
      persistent: true,
      // Preserve the persisted filesystem when reconnecting to a stopped sandbox.
      resume: true,
      // Keep only the most recent snapshot so storage stays flat.
      keepLastSnapshots: { count: 1 },
      signal: opts.signal,
      ...(opts.credentials ?? {}),
      onCreate: onCreate
        ? async () => {
            await onCreate();
          }
        : undefined,
      onResume: onResume
        ? async () => {
            await onResume();
          }
        : undefined,
    });

    return wrap(sandbox);
  }

  async stop(name: string, credentials?: Credentials): Promise<StopResult> {
    const sandbox = await Sandbox.get({ name, ...(credentials ?? {}) });
    return new VercelDevSandbox(name, sandbox, credentials).stop();
  }
}
