import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Ignore } from "ignore";
import ignore from "ignore";
import type { SyncManifest } from "./config.js";
import type { DevFile, DevSandbox } from "./sandbox.js";

/** Project root inside the sandbox (the default target for writeFiles). */
export const REMOTE_ROOT = "/vercel/sandbox";

/**
 * Always-excluded paths. `.env*` stays local so secrets do not enter persistent
 * snapshots. node_modules is excluded because we install inside the sandbox
 * instead of shipping it over the wire.
 */
const HARD_IGNORES = [
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".vercel",
  ".turbo",
  "dist",
  "build",
  ".cache",
  "coverage",
  ".DS_Store",
  "*.log",
  ".dev-install-command",
  ".dev-tools",
];

const ENV_IGNORES = [".env*"];

/**
 * Config files that commonly contain registry or tool credentials. These are
 * useful for private dependency installs, so they are available only through
 * the explicit `--include-sensitive-config` opt-in.
 */
const SENSITIVE_CONFIG_IGNORES = [".npmrc", ".yarnrc*", ".netrc", ".pypirc", ".direnv"];

/** Obvious credential/key material that should never enter a persisted snapshot. */
const SENSITIVE_KEY_IGNORES = [
  ".ssh",
  ".aws",
  ".gnupg",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_ed25519*",
];

/** Skip individual files larger than this (e.g. videos); they bloat sync. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

const CHUNK_FILES = 200;
const CHUNK_BYTES = 4 * 1024 * 1024;
// Number of batches to upload concurrently. Uploads are the bottleneck for
// large repos (many small-file round trips); parallelism cuts wall time ~3x.
const UPLOAD_CONCURRENCY = 3;

export interface CollectedFile {
  abs: string;
  /** Posix-style path relative to the project root. */
  rel: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  /** Device/inode identity captured during collection to reject path substitution at upload. */
  dev: number;
  ino: number;
  /** Safe POSIX permission bits; special bits are intentionally not propagated. */
  mode: number;
}

export interface CollectedFiles {
  files: CollectedFile[];
  skippedEnv: boolean;
  /** Config omitted by default because it commonly contains credentials. */
  skippedSensitiveConfig: string[];
  /** Obvious keys/credentials that are never uploaded. */
  skippedSensitiveKeys: string[];
  /** Local paths omitted because the operating system denied access. */
  skippedUnreadable: string[];
  /** Local files omitted because they exceed the per-file sync limit. */
  skippedLarge: string[];
  /** Local symlinks omitted instead of being followed outside the project. */
  skippedSymlinks: string[];
}

export interface SyncOptions {
  maxFileBytes?: number;
  includeSensitiveConfig?: boolean;
  /**
   * Exact relative paths to keep local for this run. This is intentionally not
   * an ignore-pattern API: a selected dotenv file may have a name such as
   * `!secrets.env`, and it still must be excluded literally.
   */
  extraIgnoredPaths?: readonly string[];
}

interface IgnoreScope {
  /** Posix path below the sync root containing this `.gitignore`; empty at root. */
  base: string;
  rules: Ignore;
}

/** Rules that cannot be re-included by project `.gitignore` files. */
export function createMandatoryIgnore(opts: { includeSensitiveConfig?: boolean } = {}): Ignore {
  const ig = ignore().add(HARD_IGNORES);
  ig.add(ENV_IGNORES);
  ig.add(SENSITIVE_KEY_IGNORES);
  if (!opts.includeSensitiveConfig) ig.add(SENSITIVE_CONFIG_IGNORES);
  return ig;
}

function scopePath(scope: IgnoreScope, rel: string, isDirectory: boolean): string | undefined {
  if (scope.base && rel !== scope.base && !rel.startsWith(`${scope.base}/`)) return undefined;
  const local = scope.base ? rel.slice(scope.base.length + 1) : rel;
  if (!local) return undefined;
  return isDirectory ? `${local}/` : local;
}

function ignoredByScopes(scopes: IgnoreScope[], rel: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const scope of scopes) {
    const local = scopePath(scope, rel, isDirectory);
    if (!local) continue;
    const result = scope.rules.test(local);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

async function readRegularFileNoFollow(
  abs: string,
  expected?: Pick<CollectedFile, "dev" | "ino">,
): Promise<Buffer> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(abs, constants.O_RDONLY | noFollow);
  try {
    const current = await handle.stat();
    if (!current.isFile()) {
      throw new Error(`Refusing to read non-file path: ${JSON.stringify(abs)}`);
    }
    if (expected && (current.dev !== expected.dev || current.ino !== expected.ino)) {
      throw new Error(`Refusing to read substituted file: ${JSON.stringify(abs)}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Recursively collect syncable files, honoring `.gitignore` except for
 * explicitly opted-in sensitive config, plus mandatory hard ignores.
 */
export async function collectFiles(dir: string, opts: SyncOptions = {}): Promise<CollectedFiles> {
  const protectedPaths = createMandatoryIgnore(opts);
  const extraIgnoredPaths = new Set(
    (opts.extraIgnoredPaths ?? []).map((rel) => validateRelativeSyncPath(rel)),
  );
  const sensitiveConfigPaths = ignore().add(SENSITIVE_CONFIG_IGNORES);
  const sensitiveKeyPaths = ignore().add(SENSITIVE_KEY_IGNORES);
  const files: CollectedFile[] = [];
  const skippedUnreadable = new Set<string>();
  const skippedLarge = new Set<string>();
  const skippedSymlinks = new Set<string>();
  const skippedSensitiveConfig = new Set<string>();
  const skippedSensitiveKeys = new Set<string>();
  let skippedEnv = false;
  const maxFileBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;

  function skipMissing(abs: string, err: unknown): boolean {
    // Live trees change while we scan them: a file can disappear, or a parent
    // directory can become a file before we reach it. The root itself is still
    // required because syncing an absent project would be unsafe.
    const code = (err as NodeJS.ErrnoException)?.code;
    return abs !== dir && (code === "ENOENT" || code === "ENOTDIR");
  }

  function skipUnreadable(abs: string, err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (
      abs === dir ||
      (code !== "EACCES" && code !== "EPERM" && code !== "EMFILE" && code !== "ENFILE")
    )
      return false;
    skippedUnreadable.add(path.relative(dir, abs).split(path.sep).join("/"));
    return true;
  }

  async function walk(absDir: string, inheritedScopes: IgnoreScope[]): Promise<void> {
    if (absDir !== dir) {
      let current: Stats;
      try {
        current = await lstat(absDir);
      } catch (err) {
        if (skipMissing(absDir, err) || skipUnreadable(absDir, err)) return;
        throw err;
      }
      if (!current.isDirectory()) {
        if (current.isSymbolicLink()) {
          skippedSymlinks.add(path.relative(dir, absDir).split(path.sep).join("/"));
        }
        return;
      }
    }

    let entries: Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (skipMissing(absDir, err) || skipUnreadable(absDir, err)) return;
      throw err;
    }
    const base = path.relative(dir, absDir).split(path.sep).join("/");
    const gitignore = entries.find((entry) => entry.name === ".gitignore" && entry.isFile());
    const scopes = [...inheritedScopes];
    if (gitignore) {
      try {
        scopes.push({
          base,
          rules: ignore().add(
            (await readRegularFileNoFollow(path.join(absDir, gitignore.name))).toString("utf8"),
          ),
        });
      } catch (err) {
        if (skipMissing(path.join(absDir, gitignore.name), err)) {
          // The file was deleted between listing and reading; subsequent events reconcile it.
        } else if (skipUnreadable(absDir, err)) {
          return;
        } else {
          throw err;
        }
      }
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = path.relative(dir, abs).split(path.sep).join("/");
      const testPath = entry.isDirectory() ? `${rel}/` : rel;
      if (extraIgnoredPaths.has(rel) || protectedPaths.ignores(testPath)) {
        if (/^\.env/.test(entry.name)) skippedEnv = true;
        if (sensitiveConfigPaths.ignores(testPath)) skippedSensitiveConfig.add(rel);
        if (sensitiveKeyPaths.ignores(testPath)) skippedSensitiveKeys.add(rel);
        continue;
      }
      const optedInSensitiveConfig =
        opts.includeSensitiveConfig && sensitiveConfigPaths.ignores(testPath);
      if (!optedInSensitiveConfig && ignoredByScopes(scopes, rel, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        await walk(abs, scopes);
      } else if (entry.isSymbolicLink()) {
        skippedSymlinks.add(rel);
      } else if (entry.isFile()) {
        let s: Stats;
        try {
          s = await stat(abs);
        } catch (err) {
          if (skipMissing(abs, err) || skipUnreadable(abs, err)) continue;
          throw err;
        }
        if (s.size > maxFileBytes) {
          skippedLarge.add(rel);
          continue;
        }
        files.push({
          abs,
          rel,
          size: s.size,
          mtimeMs: s.mtimeMs,
          ctimeMs: s.ctimeMs,
          dev: s.dev,
          ino: s.ino,
          mode: s.mode & 0o777,
        });
      }
    }
  }

  await walk(dir, []);
  return {
    files,
    skippedEnv,
    skippedSensitiveConfig: [...skippedSensitiveConfig].sort(),
    skippedSensitiveKeys: [...skippedSensitiveKeys].sort(),
    skippedUnreadable: [...skippedUnreadable].sort(),
    skippedLarge: [...skippedLarge].sort(),
    skippedSymlinks: [...skippedSymlinks].sort(),
  };
}

export function manifestOf(files: CollectedFile[]): SyncManifest {
  const m: SyncManifest = {};
  for (const f of files) {
    setManifestEntry(m, f.rel, {
      size: f.size,
      mtimeMs: f.mtimeMs,
      ctimeMs: f.ctimeMs,
      mode: f.mode,
    });
  }
  return m;
}

function setManifestEntry(
  manifest: SyncManifest,
  rel: string,
  fingerprint: SyncManifest[string],
): void {
  // File names such as `__proto__` are valid on disk. Define the property
  // directly so those names do not mutate the manifest object's prototype.
  Object.defineProperty(manifest, rel, {
    value: fingerprint,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Keep remote-tracked entries while their local subtree cannot be inspected safely. */
export function manifestAfterScan(
  prev: SyncManifest,
  files: CollectedFile[],
  skippedUnreadable: string[] = [],
): SyncManifest {
  const next = manifestOf(files);
  for (const [rel, fingerprint] of Object.entries(prev)) {
    if (
      skippedUnreadable.some((unreadable) => rel === unreadable || rel.startsWith(`${unreadable}/`))
    ) {
      setManifestEntry(next, rel, fingerprint);
    }
  }
  return next;
}

/** Files that are new or changed since the previous manifest. */
export function changedSince(prev: SyncManifest, files: CollectedFile[]): CollectedFile[] {
  return files.filter((f) => {
    const before = prev[f.rel];
    return (
      !before ||
      before.size !== f.size ||
      before.mtimeMs !== f.mtimeMs ||
      before.ctimeMs !== f.ctimeMs ||
      before.mode !== f.mode
    );
  });
}

function validateRelativeSyncPath(rel: string): string {
  const normalized = path.posix.normalize(rel);
  if (
    !rel ||
    rel.includes("\0") ||
    path.posix.isAbsolute(rel) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== rel
  ) {
    throw new Error(`Unsafe sync path in local state: ${JSON.stringify(rel)}`);
  }
  return rel;
}

/** Paths present in the previous manifest but no longer on disk. */
export function deletedSince(
  prev: SyncManifest,
  files: CollectedFile[],
  skippedUnreadable: string[] = [],
): string[] {
  const current = new Set(files.map((f) => f.rel));
  return Object.keys(prev)
    .map(validateRelativeSyncPath)
    .filter(
      (rel) =>
        !current.has(rel) &&
        !skippedUnreadable.some(
          (unreadable) => rel === unreadable || rel.startsWith(`${unreadable}/`),
        ),
    );
}

async function toDevFile(f: CollectedFile): Promise<DevFile> {
  return {
    path: validateRelativeSyncPath(f.rel),
    content: await readRegularFileNoFollow(f.abs, f),
    mode: f.mode,
  };
}

/**
 * Upload the given files to the sandbox in batches to limit memory use and
 * request size. Calls `onProgress` with the running count after each batch.
 *
 * Batches are distributed round-robin across UPLOAD_CONCURRENCY slots so
 * multiple uploads run in parallel. Reads stay sequential to avoid EMFILE.
 */
export async function uploadFiles(
  sandbox: DevSandbox,
  files: CollectedFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let pending: DevFile[] = [];
  let bytes = 0;
  let done = 0;
  // Each slot is a promise chain; batches in the same slot run sequentially,
  // but slots run concurrently, giving UPLOAD_CONCURRENCY parallel uploads.
  const slots: Promise<void>[] = Array.from({ length: UPLOAD_CONCURRENCY }, () =>
    Promise.resolve(),
  );
  let slotIdx = 0;

  const flush = () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    bytes = 0;
    const slot = slotIdx++ % UPLOAD_CONCURRENCY;
    const current = slots[slot];
    if (!current) throw new Error(`Missing upload slot ${slot}.`);
    slots[slot] = current.then(async () => {
      await sandbox.writeFiles(batch);
      done += batch.length;
      onProgress?.(done, files.length);
    });
  };

  for (const f of files) {
    pending.push(await toDevFile(f));
    bytes += f.size;
    if (pending.length >= CHUNK_FILES || bytes >= CHUNK_BYTES) flush();
  }
  flush();
  await Promise.all(slots);
}

/** Remove files from the sandbox (used by the watcher on local deletions). */
export async function removeFiles(sandbox: DevSandbox, relPaths: string[]): Promise<void> {
  if (relPaths.length === 0) return;
  const targets = relPaths.map((rel) =>
    path.posix.join(REMOTE_ROOT, validateRelativeSyncPath(rel)),
  );
  // `--` stops rm from treating any target as an option. Targets are always
  // absolute (REMOTE_ROOT-prefixed), so this is belt-and-suspenders.
  await sandbox.exec("rm", ["-f", "--", ...targets], { retryTransport: true });
}

export interface ReconcileResult {
  files: CollectedFile[];
  uploaded: number;
  deleted: number;
  changedPaths: string[];
  skippedSensitiveConfig: string[];
  skippedSensitiveKeys: string[];
  skippedUnreadable: string[];
  skippedLarge: string[];
  skippedSymlinks: string[];
}

/**
 * Re-walk the local tree and apply all changes since `prev`. Boot calls this
 * immediately before announcing readiness so edits made while install/start
 * were running are present in the sandbox before the public app is advertised.
 */
export async function reconcileFiles(
  sandbox: DevSandbox,
  dir: string,
  prev: SyncManifest,
  opts: SyncOptions = {},
): Promise<ReconcileResult> {
  const {
    files,
    skippedSensitiveConfig,
    skippedSensitiveKeys,
    skippedUnreadable,
    skippedLarge,
    skippedSymlinks,
  } = await collectFiles(dir, opts);
  const upload = changedSince(prev, files);
  const remove = deletedSince(prev, files, skippedUnreadable);
  await uploadFiles(sandbox, upload);
  await removeFiles(sandbox, remove);
  return {
    files,
    uploaded: upload.length,
    deleted: remove.length,
    changedPaths: [...upload.map((file) => file.rel), ...remove],
    skippedSensitiveConfig,
    skippedSensitiveKeys,
    skippedUnreadable,
    skippedLarge,
    skippedSymlinks,
  };
}
