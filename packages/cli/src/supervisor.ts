import source from "./supervisor.runtime.txt";

/** The in-VM supervisor script source (Node, builtins only). */
export const SUPERVISOR_SOURCE = source;

/** Where we write the supervisor inside the sandbox (outside the project root). */
export const SUPERVISOR_REMOTE_PATH = "/tmp/dev-supervisor.cjs";

/**
 * Where the CLI drops boot-progress snapshots for the supervisor to serve at
 * `/__dev/status`. The boot page polls that endpoint to drive the progress bar.
 */
export const STATUS_REMOTE_PATH = "/tmp/dev-status.json";

/** The single public port we expose; the supervisor listens here. */
export const PUBLIC_PORT = 3000;

/**
 * Port the dev server actually binds to inside the sandbox. Must differ from
 * {@link PUBLIC_PORT} (the supervisor owns that), so bump off it when they collide.
 */
export function internalDevPort(detectedPort: number): number {
  return detectedPort === PUBLIC_PORT ? PUBLIC_PORT + 1 : detectedPort;
}
