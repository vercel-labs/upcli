import type { DevSandbox } from "./sandbox.js";
import { STATUS_REMOTE_PATH } from "./supervisor.js";

/**
 * A boot-progress snapshot the CLI writes into the sandbox at each phase change.
 * The boot page eases the bar from `base` toward `ceiling` over `etaMs`,
 * approaching the ceiling asymptotically so it never lies when a phase runs
 * long, then snaps to 100% once startup reconciliation is complete.
 */
export interface BootStatus {
  /** Human label for the current phase, e.g. "installing dependencies". */
  label: string;
  /** Percent the bar starts this phase at (the previous phase's ceiling). */
  base: number;
  /** Percent the bar approaches but never reaches until the phase completes. */
  ceiling: number;
  /** Expected duration of this phase, used only to pace the bar (never shown). */
  etaMs: number;
  /** Release public proxying only after startup reconciliation has completed. */
  ready?: boolean;
}

/** Push a progress snapshot; only the final proxy-release write is required. */
export async function writeStatus(
  sandbox: DevSandbox,
  status: BootStatus,
  opts: { required?: boolean } = {},
): Promise<void> {
  try {
    await sandbox.writeFiles([{ path: STATUS_REMOTE_PATH, content: JSON.stringify(status) }]);
  } catch (err) {
    if (opts.required) throw err;
    // The progress bar is a nicety; it must never block or fail the boot.
  }
}

/**
 * First-run install pacing from the dependency count. Bigger dependency trees
 * take longer to install, so we give the install segment a longer ETA. This is
 * only a guess for the very first run; afterwards we use the measured duration.
 */
export function installEtaFromDeps(depCount: number): number {
  if (depCount < 25) return 15_000;
  if (depCount < 75) return 30_000;
  if (depCount < 150) return 50_000;
  return 75_000;
}

/** Rough dev-server boot time per framework, used until we have a measurement. */
export function startEtaFor(slug: string | null | undefined): number {
  switch (slug) {
    case "nextjs":
    case "nuxtjs":
      return 9_000;
    case "astro":
      return 6_000;
    case "vite":
    case "sveltekit":
      return 4_000;
    default:
      return 8_000;
  }
}
