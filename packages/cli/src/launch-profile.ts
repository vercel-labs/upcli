import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readLaunchProfile, rememberLaunchProfile, writeFileAtomic } from "./config.js";
import { validateDependencyFilePattern } from "./dependency-files.js";
import { type Detected, detect, type LaunchProfile } from "./detect.js";

export const SHARED_CONFIG_FILE = "up.config.json";
export const LEGACY_SHARED_CONFIG_FILE = "dev.config.json";

// Bounds on checked-in config, which is attacker-controllable (a cloned repo) and
// parsed on the user's own machine before it is trusted.
const MAX_SHARED_CONFIG_BYTES = 64 * 1024;
const MAX_DEPENDENCY_FILES = 256;

export interface LaunchOverrides {
  command?: string;
  installCommand?: string | null;
  port?: number;
}

export interface PromptDraft {
  detected: Detected;
  installCommand: string | null;
  port: number;
}

export type ProfilePrompt = (draft: PromptDraft) => Promise<LaunchProfile>;

export interface ResolvedLaunchProfile {
  detected: Detected;
  profile: LaunchProfile;
  /** Highest-precedence input that materially supplied the command. */
  source: "flags" | "shared config" | "local config" | "detection" | "interactive";
  /** True when executable commands selected for this run came from checked-in config. */
  executesSharedCommands: boolean;
}

type PartialProfile = Partial<Omit<LaunchProfile, "installCommand">> & {
  installCommand?: string | null;
};

function validPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function parsePartialProfile(value: unknown, from: string): PartialProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${from} must contain a JSON object.`);
  }
  const raw = value as Record<string, unknown>;
  const parsed: PartialProfile = {};
  if ("devCommand" in raw) {
    if (typeof raw.devCommand !== "string" || raw.devCommand.trim() === "") {
      throw new Error(`${from}: devCommand must be a non-empty string.`);
    }
    parsed.devCommand = raw.devCommand;
  }
  if ("installCommand" in raw) {
    if (
      raw.installCommand !== null &&
      (typeof raw.installCommand !== "string" || raw.installCommand.trim() === "")
    ) {
      throw new Error(`${from}: installCommand must be a non-empty string or null.`);
    }
    parsed.installCommand = raw.installCommand as string | null;
  }
  if ("port" in raw) {
    if (!validPort(raw.port)) {
      throw new Error(`${from}: port must be an integer between 1 and 65535.`);
    }
    parsed.port = raw.port;
  }
  if ("dependencyFiles" in raw) {
    if (
      !Array.isArray(raw.dependencyFiles) ||
      !raw.dependencyFiles.every((file) => typeof file === "string")
    ) {
      throw new Error(`${from}: dependencyFiles must be an array of strings.`);
    }
    if (raw.dependencyFiles.length > MAX_DEPENDENCY_FILES) {
      throw new Error(
        `${from}: dependencyFiles must list at most ${MAX_DEPENDENCY_FILES} patterns.`,
      );
    }
    parsed.dependencyFiles = raw.dependencyFiles.map((file) =>
      validateDependencyFilePattern(file, `${from}: dependencyFiles`),
    );
  }
  return parsed;
}

export async function readSharedProfile(dir: string): Promise<PartialProfile | undefined> {
  for (const fileName of [SHARED_CONFIG_FILE, LEGACY_SHARED_CONFIG_FILE]) {
    const file = path.join(dir, fileName);
    try {
      // Refuse an oversized config before buffering it into memory.
      const { size } = await stat(file);
      if (size > MAX_SHARED_CONFIG_BYTES) {
        throw new Error(`${fileName} is too large (limit ${MAX_SHARED_CONFIG_BYTES} bytes).`);
      }
      return parsePartialProfile(JSON.parse(await readFile(file, "utf8")), fileName);
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") continue;
      throw err;
    }
  }
  return undefined;
}

export async function writeSharedProfile(dir: string, profile: LaunchProfile): Promise<void> {
  const file = path.join(dir, SHARED_CONFIG_FILE);
  await writeFileAtomic(file, `${JSON.stringify(profile, null, 2)}\n`);
}

/**
 * Resolve launch settings one field at a time in documented precedence order:
 * CLI flags > `up.config.json`/`dev.config.json` > local remembered profile > detection. If no
 * command remains, prompt once and keep that result local for future runs.
 */
export async function resolveLaunchProfile(
  dir: string,
  opts: {
    overrides?: LaunchOverrides;
    saveConfig?: boolean;
    prompt: ProfilePrompt;
  },
): Promise<ResolvedLaunchProfile> {
  const detected = await detect(dir);
  const local = await readLaunchProfile(dir);
  let localParsed: PartialProfile | undefined;
  if (local) {
    try {
      localParsed = parsePartialProfile(local, "remembered launch profile");
    } catch {
      // Stale or hand-edited local profile; ignore it and re-detect cleanly.
    }
  }
  const shared = await readSharedProfile(dir);
  const overrides = opts.overrides ?? {};
  const base: PartialProfile = detected.profile ?? {
    installCommand: detected.suggestedInstallCommand,
    port: detected.suggestedPort,
    dependencyFiles: detected.dependencyFiles,
  };
  const merged: PartialProfile = {
    ...base,
    ...localParsed,
    ...shared,
    ...(overrides.command !== undefined ? { devCommand: overrides.command } : {}),
    ...(overrides.installCommand !== undefined ? { installCommand: overrides.installCommand } : {}),
    ...(overrides.port !== undefined ? { port: overrides.port } : {}),
  };

  let profile: LaunchProfile;
  let source: ResolvedLaunchProfile["source"];
  let executesSharedCommands = false;
  if (!merged.devCommand) {
    profile = await opts.prompt({
      detected,
      installCommand: merged.installCommand ?? null,
      port: merged.port ?? detected.suggestedPort,
    });
    await rememberLaunchProfile(dir, profile);
    source = "interactive";
  } else {
    profile = {
      installCommand: merged.installCommand ?? null,
      devCommand: merged.devCommand,
      port: merged.port ?? detected.suggestedPort,
      dependencyFiles: merged.dependencyFiles ?? detected.dependencyFiles,
    };
    source =
      overrides.command !== undefined
        ? "flags"
        : shared?.devCommand
          ? "shared config"
          : localParsed?.devCommand
            ? "local config"
            : "detection";
    executesSharedCommands =
      (overrides.command === undefined && shared?.devCommand !== undefined) ||
      (overrides.installCommand === undefined && typeof shared?.installCommand === "string");
  }

  if (opts.saveConfig) {
    await writeSharedProfile(dir, profile);
  }
  return { detected, profile, source, executesSharedCommands };
}
