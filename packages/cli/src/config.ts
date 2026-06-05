import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import envPaths from "env-paths";
import type { LaunchProfile } from "./detect.js";

/** Write a complete file atomically through a sibling temporary file. */
export async function writeFileAtomic(
  file: string,
  data: string,
  opts: { mode?: number } = {},
): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, opts.mode === undefined ? undefined : { mode: opts.mode });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Resolve platform state folders, or the test/user `DEV_STATE_DIR` override. */
function stateDirs(): { config: string; cache: string } {
  const override = process.env.DEV_STATE_DIR;
  if (override) return { config: override, cache: override };
  const paths = envPaths("dev", { suffix: "" });
  return { config: paths.config, cache: paths.cache };
}

/**
 * Stable sandbox name for one local installation and one project path. The
 * random installation id prevents another machine with the same checkout path
 * from accidentally resuming or overwriting this sandbox.
 */
export function sandboxNameFor(absDir: string, installationId: string): string {
  const hash = createHash("sha256")
    .update(absDir)
    .update("\0")
    .update(installationId)
    .digest("hex")
    .slice(0, 12);
  return `dev-${hash}`;
}

/**
 * Measured durations (ms) of each boot phase from the last successful run of a
 * project. Used to pace the boot-progress bar faithfully on subsequent runs
 * instead of guessing from heuristics.
 */
export interface PhaseTimings {
  sync?: number;
  install?: number;
  start?: number;
}

export interface ProjectRecord {
  /** Absolute path of the project directory. */
  dir: string;
  /** Persistent sandbox name. */
  sandbox: string;
  /** Last time we synced/started, ms epoch. */
  updatedAt: number;
  /** Measured boot-phase durations from the previous run. */
  timings?: PhaseTimings;
  /** User-selected launch configuration kept local to this machine. */
  launchProfile?: LaunchProfile;
  /** Commands from checked-in config that this user has explicitly trusted. */
  trustedSharedCommandKeys?: string[];
  /**
   * Local decision for the conventional `.env.local` prompt. A string means
   * inject that file on future runs, null means the user declined, and
   * undefined means we have not asked yet.
   */
  envFile?: string | null;
  /**
   * Whether a run uploaded credential-bearing config via
   * `--include-sensitive-config`. Sticky once true: those files persist in the
   * sandbox snapshot across resumes until the sandbox is recreated from
   * scratch. Used to warn on resume when the current run omits the flag.
   */
  sensitiveConfigUsed?: boolean;
}

interface Store {
  projects: Record<string, ProjectRecord>;
}

function storeFilePath(): string {
  return path.join(stateDirs().config, "projects.json");
}

function installationFilePath(): string {
  return path.join(stateDirs().config, "installation.json");
}

interface InstallationStore {
  id: string;
}

async function readOrCreateInstallationId(): Promise<string> {
  const file = installationFilePath();
  try {
    const store = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (
      !store ||
      typeof store !== "object" ||
      Array.isArray(store) ||
      typeof (store as InstallationStore).id !== "string" ||
      !(store as InstallationStore).id
    ) {
      throw new Error("expected an object with a non-empty id");
    }
    return (store as InstallationStore).id;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Could not read installation state at ${file}: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }

  const id = randomUUID();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${JSON.stringify({ id }, null, 2)}\n`, { mode: 0o600 });
  return id;
}

async function readStore(): Promise<Store> {
  try {
    const store = JSON.parse(await readFile(storeFilePath(), "utf8")) as unknown;
    if (
      !store ||
      typeof store !== "object" ||
      Array.isArray(store) ||
      !("projects" in store) ||
      !store.projects ||
      typeof store.projects !== "object" ||
      Array.isArray(store.projects)
    ) {
      throw new Error("expected an object with a projects map");
    }
    return store as Store;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { projects: {} };
    throw new Error(`Could not read state at ${storeFilePath()}: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

async function writeStore(store: Store): Promise<void> {
  const file = storeFilePath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function storedSandboxName(rec: ProjectRecord | undefined): string | undefined {
  return typeof rec?.sandbox === "string" && rec.sandbox ? rec.sandbox : undefined;
}

// In-process mutex: chains store mutations so they never overlap within a
// single Node.js process. The lock file extends that guarantee cross-process.
let storeMutex = Promise.resolve();

async function withStore(fn: (store: Store) => Promise<void> | void): Promise<void> {
  const result = storeMutex.then(async () => {
    const lockFile = `${storeFilePath()}.lock`;
    const deadline = Date.now() + 2000;
    while (true) {
      try {
        const handle = await open(lockFile, "wx");
        await handle.close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (Date.now() >= deadline) break; // proceed rather than hang
        await new Promise<void>((r) => setTimeout(r, 50));
      }
    }
    try {
      const store = await readStore();
      await fn(store);
      await writeStore(store);
    } finally {
      await unlink(lockFile).catch(() => {});
    }
  });
  storeMutex = result.catch(() => {}); // errors don't block future writers
  return result;
}

export async function rememberProject(rec: ProjectRecord): Promise<void> {
  await withStore((store) => {
    // Merge so we don't clobber fields written by other calls (e.g. timings).
    store.projects[rec.dir] = { ...store.projects[rec.dir], ...rec };
  });
}

/**
 * Resolve the sandbox name for a local project. Existing local records keep
 * their original name so upgrading the CLI does not strand resumable
 * environments; new projects are scoped to this installation's random id.
 */
export async function resolveSandboxName(dir: string): Promise<string> {
  const existing = storedSandboxName((await readStore()).projects[dir]);
  return existing ?? sandboxNameFor(dir, await readOrCreateInstallationId());
}

/** Boot-phase durations measured on the last successful run, if any. */
export async function readTimings(dir: string): Promise<PhaseTimings> {
  const store = await readStore();
  return store.projects[dir]?.timings ?? {};
}

/** Persist measured boot-phase durations for use as next run's ETA. */
export async function recordTimings(dir: string, timings: PhaseTimings): Promise<void> {
  await withStore((store) => {
    const rec = store.projects[dir];
    if (rec) rec.timings = { ...rec.timings, ...timings };
  });
}

/** Read a locally remembered custom/interactive launch profile. */
export async function readLaunchProfile(dir: string): Promise<LaunchProfile | undefined> {
  const store = await readStore();
  return store.projects[dir]?.launchProfile;
}

/** Remember a profile locally without making it a committed project setting. */
export async function rememberLaunchProfile(dir: string, profile: LaunchProfile): Promise<void> {
  const installationId = await readOrCreateInstallationId();
  await withStore((store) => {
    const existing = store.projects[dir];
    store.projects[dir] = {
      dir,
      sandbox: storedSandboxName(existing) ?? sandboxNameFor(dir, installationId),
      updatedAt: existing?.updatedAt ?? Date.now(),
      ...existing,
      launchProfile: profile,
    };
  });
}

/** Whether a previous run persisted sensitive config into this project's sandbox. */
export async function readSensitiveConfigUsed(dir: string): Promise<boolean> {
  return (await readStore()).projects[dir]?.sensitiveConfigUsed === true;
}

/** Read the locally remembered dotenv injection decision for a project. */
export async function readEnvFilePreference(dir: string): Promise<string | null | undefined> {
  const value = (await readStore()).projects[dir]?.envFile;
  return typeof value === "string" || value === null ? value : undefined;
}

/** Remember a local dotenv injection decision without making it shareable. */
export async function rememberEnvFilePreference(
  dir: string,
  envFile: string | null,
): Promise<void> {
  const installationId = await readOrCreateInstallationId();
  await withStore((store) => {
    const existing = store.projects[dir];
    store.projects[dir] = {
      dir,
      sandbox: storedSandboxName(existing) ?? sandboxNameFor(dir, installationId),
      updatedAt: existing?.updatedAt ?? Date.now(),
      ...existing,
      envFile,
    };
  });
}

function sharedCommandTrustKey(
  profile: LaunchProfile,
  hasEnvFile: boolean,
  includeSensitiveConfig = false,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        installCommand: profile.installCommand,
        devCommand: profile.devCommand,
        // Dependency inputs decide when a trusted install command is rerun.
        // Treat changes as a new execution contract rather than silently
        // reusing consent for a broader or narrower set of triggers.
        dependencyFiles: [...profile.dependencyFiles].sort(),
        hasEnvFile,
        includeSensitiveConfig,
      }),
    )
    .digest("hex");
}

export async function trustsSharedCommands(
  dir: string,
  profile: LaunchProfile,
  hasEnvFile: boolean,
  includeSensitiveConfig = false,
): Promise<boolean> {
  const store = await readStore();
  const keys = store.projects[dir]?.trustedSharedCommandKeys;
  return (
    Array.isArray(keys) &&
    keys.includes(sharedCommandTrustKey(profile, hasEnvFile, includeSensitiveConfig))
  );
}

export async function rememberTrustedSharedCommands(
  dir: string,
  profile: LaunchProfile,
  hasEnvFile: boolean,
  includeSensitiveConfig = false,
): Promise<void> {
  const installationId = await readOrCreateInstallationId();
  const key = sharedCommandTrustKey(profile, hasEnvFile, includeSensitiveConfig);
  await withStore((store) => {
    const existing = store.projects[dir];
    const previousKeys = Array.isArray(existing?.trustedSharedCommandKeys)
      ? existing.trustedSharedCommandKeys.filter((candidate) => typeof candidate === "string")
      : [];
    const keys = new Set(previousKeys);
    keys.add(key);
    store.projects[dir] = {
      dir,
      sandbox: storedSandboxName(existing) ?? sandboxNameFor(dir, installationId),
      updatedAt: existing?.updatedAt ?? Date.now(),
      ...existing,
      trustedSharedCommandKeys: [...keys],
    };
  });
}

export async function listProjects(): Promise<ProjectRecord[]> {
  const store = await readStore();
  return Object.values(store.projects).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Per-file fingerprint used for incremental sync. We use size + mtime + ctime
 * + mode (not a content hash) because it is much cheaper to compute and good
 * enough to decide what changed since the last session.
 */
export interface SyncManifest {
  [relPath: string]: { size: number; mtimeMs: number; ctimeMs?: number; mode?: number };
}

function manifestFile(sandboxName: string): string {
  return path.join(stateDirs().cache, `${sandboxName}.manifest.json`);
}

export async function readManifest(sandboxName: string): Promise<SyncManifest> {
  try {
    return JSON.parse(await readFile(manifestFile(sandboxName), "utf8")) as SyncManifest;
  } catch {
    return {};
  }
}

export async function writeManifest(sandboxName: string, manifest: SyncManifest): Promise<void> {
  const file = manifestFile(sandboxName);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, JSON.stringify(manifest), { mode: 0o600 });
}
