import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import { defineCommand, runMain } from "citty";
import pc from "picocolors";
import { credentialsFor, resolveAuth } from "./auth.js";
import {
  listProjects,
  readEnvFilePreference,
  readManifest,
  readSensitiveConfigUsed,
  readTimings,
  recordTimings,
  rememberEnvFilePreference,
  rememberProject,
  rememberTrustedSharedCommands,
  resolveSandboxName,
  trustsSharedCommands,
  writeManifest,
} from "./config.js";
import { dependencyInputMatches } from "./dependency-files.js";
import type { LaunchProfile } from "./detect.js";
import { type EnvFile, findDefaultEnvFile, readEnvFile } from "./env.js";
import { type PromptDraft, resolveLaunchProfile } from "./launch-profile.js";
import { SandboxLifecycle } from "./lifecycle.js";
import { waitForPort, waitForSupervisor } from "./ready.js";
import type { DevSandbox } from "./sandbox.js";
import { DEFAULT_TIMEOUT_MS, VercelProvider } from "./sandbox.js";
import { installEtaFromDeps, startEtaFor, writeStatus } from "./status.js";
import {
  internalDevPort,
  PUBLIC_PORT,
  STATUS_REMOTE_PATH,
  SUPERVISOR_REMOTE_PATH,
  SUPERVISOR_SOURCE,
} from "./supervisor.js";
import {
  changedSince,
  collectFiles,
  deletedSince,
  MAX_FILE_BYTES,
  manifestAfterScan,
  REMOTE_ROOT,
  reconcileFiles,
  removeFiles,
  uploadFiles,
} from "./sync.js";
import {
  installMarker,
  needsProvisioning,
  projectCommand,
  provisionToolchain,
} from "./toolchain.js";
import { copyToClipboard, openUrl, sanitizeTerminalText, TerminalFlow } from "./ui.js";
import { watchProject } from "./watch.js";
import { unsafeWorkingDirectory } from "./working-directory.js";

// Silence noisy transitive deprecation warnings (e.g. punycode) for clean output.
process.noDeprecation = true;

const INSTALL_MARKER_PATH = `${REMOTE_ROOT}/.dev-install-command`;
const BACKGROUND_STOP_TARGET = "__background-stop";

async function resolveDir(input: string): Promise<string> {
  const dir = path.resolve(process.cwd(), input);
  const s = await stat(dir).catch(() => null);
  if (!s?.isDirectory()) {
    p.cancel(`Not a directory: ${pc.bold(sanitizeTerminalText(dir))}`);
    process.exit(1);
  }
  // Canonicalize so /tmp and /private/tmp (macOS) always resolve to the same
  // sandbox name and manifest cache key.
  return await realpath(dir);
}

/** True if `absPath` contains the exact marker content inside the sandbox. */
async function remoteTextEquals(
  sandbox: DevSandbox,
  absPath: string,
  expected: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const { exitCode } = await sandbox.exec(
    "bash",
    ["-c", 'test -f "$1" && test "$(cat "$1")" = "$2"', "dev", absPath, expected],
    { signal },
  );
  return exitCode === 0;
}

/** Count declared dependencies; used to pace the install segment on a cold run. */
async function countDeps(dir: string): Promise<number> {
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    return (
      Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length
    );
  } catch {
    return 0;
  }
}

function formatElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function interactive(): boolean {
  return process.stdin.isTTY === true;
}

async function promptForLaunchProfile(draft: PromptDraft): Promise<LaunchProfile> {
  if (!interactive()) {
    p.log.error(
      (draft.detected.kind === "python"
        ? "Python entrypoint is ambiguous and no interactive terminal is available."
        : "No dev command was detected and no interactive terminal is available.") +
        `\nSpecify it with ${pc.cyan("up . --command '<start-command>'")}` +
        (draft.detected.kind !== "python" && draft.installCommand !== undefined
          ? ` and ${pc.cyan("--install-command")}`
          : "") +
        ".",
    );
    process.exit(1);
  }
  p.log.info(
    pc.dim(
      draft.detected.kind === "python"
        ? "Python entrypoint is ambiguous; enter the command that serves your app."
        : "No automatic dev command was detected; enter how to start this project.",
    ),
  );
  const command = await p.text({
    message: "Dev command (use $PORT for the listening port)",
    placeholder:
      draft.detected.kind === "python"
        ? "python3 -m uvicorn app:app --host 0.0.0.0 --port $PORT"
        : "npm run dev",
    validate: (value) => (value?.trim() ? undefined : "A dev command is required."),
  });
  if (p.isCancel(command)) {
    p.cancel("Configuration cancelled.");
    process.exit(1);
  }
  const install = await p.text({
    message: "Install command (leave blank to skip)",
    initialValue: draft.installCommand ?? "",
  });
  if (p.isCancel(install)) {
    p.cancel("Configuration cancelled.");
    process.exit(1);
  }
  const portInput = await p.text({
    message: "Internal server port",
    initialValue: String(draft.port),
    validate: (value) => {
      const n = Number(value);
      return Number.isInteger(n) && n >= 1 && n <= 65535
        ? undefined
        : "Use an integer between 1 and 65535.";
    },
  });
  if (p.isCancel(portInput)) {
    p.cancel("Configuration cancelled.");
    process.exit(1);
  }
  return {
    installCommand: install.trim() ? install : null,
    devCommand: command,
    port: Number(portInput),
    dependencyFiles: draft.detected.dependencyFiles,
  };
}

function displayCommand(command: string | null): string {
  // JSON.stringify escapes ESC and quotes but leaves C1 bytes and DEL intact;
  // sanitizeTerminalText renders those literally so up.config.json can't inject
  // control bytes into the trust panel.
  return command === null ? "(skip)" : sanitizeTerminalText(JSON.stringify(command));
}

async function confirmSharedCommands(
  ui: TerminalFlow,
  dir: string,
  profile: LaunchProfile,
  hasEnvFile: boolean,
  includeSensitiveConfig: boolean,
): Promise<void> {
  if (await trustsSharedCommands(dir, profile, hasEnvFile, includeSensitiveConfig)) return;

  if (!interactive()) {
    await ui.outro(
      pc.dim(
        "Shared project commands require confirmation in an interactive terminal.\n" +
          "Run `up .` locally once to review and trust them, then re-run.",
      ),
    );
    process.exit(1);
  }

  await ui.note(
    `${pc.bold("Install:")} ${displayCommand(profile.installCommand)}\n` +
      `${pc.bold("Dev:")} ${displayCommand(profile.devCommand)}` +
      (hasEnvFile ? `\n! Local env values are injected for this run.` : "") +
      (includeSensitiveConfig ? `\n! Sensitive config may persist in this sandbox.` : ""),
    "Review up.config.json commands",
  );
  const accepted = await p.confirm({
    message: "Trust and run these shared commands in your sandbox on this machine?",
    initialValue: false,
  });
  if (p.isCancel(accepted) || !accepted) {
    await ui.outro(pc.dim("Aborted before executing shared project commands."));
    process.exit(1);
  }
  await rememberTrustedSharedCommands(dir, profile, hasEnvFile, includeSensitiveConfig);
}

async function readOptionalEnvFile(dir: string, input: string): Promise<EnvFile | undefined> {
  try {
    return await readEnvFile(dir, input);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return fail(err);
  }
}

async function resolveEnvFile(
  ui: TerminalFlow,
  dir: string,
  explicit?: string,
): Promise<EnvFile | undefined> {
  if (explicit) {
    return await readEnvFile(dir, explicit).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        p.log.error(`Env file not found: ${pc.bold(sanitizeTerminalText(explicit))}`);
        process.exit(1);
      }
      return fail(err);
    });
  }

  const preference = await readEnvFilePreference(dir);
  if (typeof preference === "string") return await readOptionalEnvFile(dir, preference);
  if (preference === null) return undefined;

  const candidate = await findDefaultEnvFile(dir).catch((err) => fail(err));
  if (!candidate) return undefined;

  if (!interactive()) {
    await ui.info(
      pc.dim(
        `${pc.bold(candidate)} found. Pass ${pc.cyan(`--env-file ${candidate}`)} to inject it.`,
      ),
    );
    return undefined;
  }

  await ui.note(
    `${pc.bold(candidate)} stays local; it is injected only into this dev server.`,
    "Local env file found",
  );
  const accepted = await p.confirm({
    message: `Inject ${candidate} into the remote dev server now and on future runs?`,
    initialValue: false,
  });
  if (p.isCancel(accepted)) {
    await ui.outro(pc.dim("Configuration cancelled."));
    process.exit(1);
  }
  await rememberEnvFilePreference(dir, accepted ? candidate : null);
  if (!accepted) return undefined;
  return await readEnvFile(dir, candidate).catch((err) => fail(err));
}

async function runDev(
  input: string,
  opts: {
    open?: boolean;
    envFile?: string;
    includeSensitiveConfig?: boolean;
    port?: number;
    command?: string;
    installCommand?: string | null;
    saveConfig?: boolean;
  },
) {
  const ui = new TerminalFlow();
  ui.intro();
  const dir = await resolveDir(input);
  const unsafeRoot = await unsafeWorkingDirectory(dir);
  if (unsafeRoot) {
    const location = unsafeRoot === "home" ? "your home directory" : "the filesystem root";
    await ui.error(`Cannot run up from ${location}; it could upload files outside a project.`);
    await ui.info(
      `Change into a project first, for example: ${pc.bold("cd ~/projects/my-app && up .")}`,
    );
    await ui.outro(pc.dim("Nothing was uploaded."));
    process.exitCode = 1;
    return;
  }
  const includeSensitiveConfig = Boolean(opts.includeSensitiveConfig);

  // Close the intro box cleanly on early Ctrl-C (before a sandbox exists and
  // before the main SIGINT handler below is installed). Nothing is uploaded yet
  // so this is safe to handle with a simple exit.
  const earlyAbort = async () => {
    await ui.outro(pc.dim("Aborted."));
    process.exit(1);
  };
  process.once("SIGINT", earlyAbort);
  process.once("SIGTERM", earlyAbort);

  // 1. Auth (reuse Vercel CLI login).
  const authSpin = ui.spinner();
  authSpin.start("Authenticating with Vercel");
  let auth: Awaited<ReturnType<typeof resolveAuth>>;
  try {
    auth = await resolveAuth(dir);
  } catch (err) {
    await authSpin.fail("Authentication failed");
    return fail(err);
  }
  if (auth.kind === "anonymous") {
    await authSpin.stop("Not logged in");
    await ui.note(`Run ${pc.cyan("vercel login")} and try again.`, "Authentication required");
    await ui.outro(pc.dim("Aborted."));
    process.exit(1);
  }
  await authSpin.stop("Authenticated");

  // 2. Resolve the working-directory launch contract.
  const resolved = await resolveLaunchProfile(dir, {
    overrides: {
      ...(opts.command !== undefined ? { command: opts.command } : {}),
      ...(opts.installCommand !== undefined ? { installCommand: opts.installCommand } : {}),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
    },
    saveConfig: opts.saveConfig,
    prompt: promptForLaunchProfile,
  }).catch((err) => fail(err));
  const { detected: det, profile } = resolved;
  const envFile = await resolveEnvFile(ui, dir, opts.envFile);
  const syncOptions = {
    includeSensitiveConfig,
    ...(envFile ? { extraIgnoredPaths: [envFile.rel] } : {}),
  };
  await ui.step(`${pc.bold(det.name)} ${pc.dim(`· ${resolved.source} · port ${profile.port}`)}`);
  if (resolved.executesSharedCommands) {
    await confirmSharedCommands(ui, dir, profile, Boolean(envFile), includeSensitiveConfig);
  } else if (opts.saveConfig) {
    // `--save-config` is an explicit act of sharing the commands selected in this run.
    await rememberTrustedSharedCommands(dir, profile, Boolean(envFile), includeSensitiveConfig);
  }
  if (opts.saveConfig) {
    await ui.info(pc.dim("Saved launch settings to up.config.json."));
  }

  // 3. Collect files to sync.
  const {
    files,
    skippedEnv,
    skippedSensitiveConfig,
    skippedSensitiveKeys,
    skippedUnreadable,
    skippedLarge,
    skippedSymlinks,
  } = await collectFiles(dir, syncOptions);
  const reportedSkipped = new Map<string, Set<string>>();
  const reportSkipped = async (
    kind: string,
    paths: string[],
    message: string,
    level: "info" | "warn" = "warn",
  ) => {
    const reported = reportedSkipped.get(kind) ?? new Set<string>();
    reportedSkipped.set(kind, reported);
    const fresh = paths.filter((rel) => !reported.has(rel));
    if (!fresh.length) return;
    for (const rel of fresh) reported.add(rel);
    if (level === "info") {
      await ui.info(`${message}: ${formatPaths(fresh)}.`);
    } else {
      await ui.warn(`${message}: ${formatPaths(fresh)}.`);
    }
  };
  const reportSkippedPaths = async (result: {
    skippedSensitiveConfig: string[];
    skippedSensitiveKeys: string[];
    skippedUnreadable: string[];
    skippedLarge: string[];
    skippedSymlinks: string[];
  }) => {
    await reportSkipped(
      "sensitive-config",
      result.skippedSensitiveConfig,
      "Sensitive config stayed local",
      "info",
    );
    await reportSkipped(
      "sensitive-keys",
      result.skippedSensitiveKeys,
      "Private key material stayed local",
      "info",
    );
    await reportSkipped("unreadable", result.skippedUnreadable, "Skipped unreadable local path");
    await reportSkipped(
      "large",
      result.skippedLarge,
      `Skipped local file larger than ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB`,
    );
    await reportSkipped("symlink", result.skippedSymlinks, "Skipped local symlink");
  };
  if (envFile) {
    await ui.info(`Using ${pc.bold(envFile.rel)}; injected only, never uploaded or persisted.`);
  } else if (skippedEnv) {
    await ui.info(`Local env files stay local. Use ${pc.bold("--env-file")} to inject one.`);
  }
  if (includeSensitiveConfig) {
    await ui.info(`Sensitive config enabled; matching files may persist.`);
  }
  await reportSkippedPaths({
    skippedSensitiveConfig,
    skippedSensitiveKeys,
    skippedUnreadable,
    skippedLarge,
    skippedSymlinks,
  });

  const provider = new VercelProvider();
  const name = await resolveSandboxName(dir);
  const credentials = credentialsFor(auth);
  const devPort = internalDevPort(profile.port);

  // 4. Get or resume the persistent sandbox (exposes the single public port).
  const bootSpin = ui.spinner();
  bootSpin.start("Starting sandbox");
  let sandbox: DevSandbox;
  // SDK create/resume callbacks may settle just after `getOrCreate` resolves.
  let settleLifecycle: (resumed: boolean) => void = () => {};
  const lifecycle = new Promise<boolean>((resolve) => {
    settleLifecycle = resolve;
  });
  const bootStart = Date.now();
  let sharedUrl: string | undefined;
  try {
    sandbox = await provider.getOrCreate({
      name,
      credentials,
      ports: [PUBLIC_PORT],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      onCreate: () => settleLifecycle(false),
      onResume: () => settleLifecycle(true),
    });
  } catch (err) {
    await bootSpin.fail("Could not start sandbox");
    return fail(err);
  }
  const resources = new SandboxLifecycle(sandbox);
  let stopBackground = () => {};
  let cleaningUp = false;
  let liveUrl: string | undefined;
  const onSignal = () => {
    if (cleaningUp) return;
    cleaningUp = true;
    stopBackground();
    resources.cancelWork();
    const urlHint = liveUrl ? ` · ${liveUrl}` : "";
    ui.outroNow(
      pc.dim(`Sandbox is still running${urlHint}. Run ${pc.cyan("up stop")} to stop it.`),
    );
    process.exit(0);
  };
  process.off("SIGINT", earlyAbort);
  process.off("SIGTERM", earlyAbort);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // Detect whether the sandbox was just created, resumed from snapshot, or was
  // already running (detached from a previous `up .` session).
  type BootMode = "created" | "resumed" | "reconnected";
  const bootMode = await Promise.race<BootMode>([
    lifecycle.then((wasResumed) => (wasResumed ? "resumed" : "created")),
    new Promise<BootMode>((resolve) => setTimeout(() => resolve("reconnected"), 1500)),
  ]);
  const bootMs = Date.now() - bootStart;
  await bootSpin.stop(
    bootMode === "resumed"
      ? `Restoring sandbox ${pc.dim(`· snapshot restore ${formatElapsed(bootMs)}`)}`
      : bootMode === "reconnected"
        ? `Reconnecting to running sandbox ${pc.dim(`· ${formatElapsed(bootMs)}`)}`
        : `Created sandbox runtime ${pc.dim(`· empty sandbox ${formatElapsed(bootMs)}`)}`,
  );

  // Sensitive config uploaded by a previous run persists in the snapshot. When
  // resuming such a sandbox without re-passing the flag, remind the user those
  // files are still present so it is never a silent surprise.
  const priorSensitiveConfig = await readSensitiveConfigUsed(dir);
  if (bootMode !== "created" && priorSensitiveConfig && !includeSensitiveConfig) {
    await ui.warn(
      "A previous run used --include-sensitive-config, so files like .npmrc or .netrc may still " +
        "be in this sandbox snapshot. Run `up stop` and start fresh to remove them.",
    );
  }

  try {
    // 5. Make the public boot page live before syncing or installing.
    const shareSpin = ui.spinner();
    shareSpin.start("Preparing shareable URL");
    const { copied, url } = await (async () => {
      const runId = randomUUID();
      await resources.run(() =>
        sandbox.writeFiles([
          { path: SUPERVISOR_REMOTE_PATH, content: SUPERVISOR_SOURCE },
          {
            path: STATUS_REMOTE_PATH,
            content: JSON.stringify({
              label: "preparing sandbox",
              base: 0,
              ceiling: 10,
              etaMs: 4000,
              ready: false,
            }),
          },
        ]),
      );
      await resources.run((signal) =>
        sandbox
          .exec("bash", ["-c", "pkill -f dev-supervisor.cjs >/dev/null 2>&1 || true"], { signal })
          .catch(() => ({ exitCode: 0 })),
      );
      const supervisorProc = await resources.run((signal) =>
        sandbox.spawn("node", [SUPERVISOR_REMOTE_PATH], {
          env: {
            DEV_PUBLIC_PORT: String(PUBLIC_PORT),
            DEV_TARGET_PORT: String(devPort),
            DEV_STATUS_FILE: STATUS_REMOTE_PATH,
            DEV_RUN_ID: runId,
          },
          signal,
        }),
      );
      resources.addProcess(supervisorProc);
      const url = sandbox.domain(PUBLIC_PORT);

      if (!(await resources.run((signal) => waitForSupervisor(url, runId, 20_000, signal)))) {
        throw new Error("The up supervisor did not come up for this run.");
      }
      const copied = await copyToClipboard(url);
      // Sticky: once sensitive config is in the snapshot it stays until the
      // sandbox is recreated fresh, so carry the prior flag forward on resume.
      const sensitiveConfigUsed =
        bootMode === "created"
          ? includeSensitiveConfig
          : priorSensitiveConfig || includeSensitiveConfig;
      await rememberProject({ dir, sandbox: name, updatedAt: Date.now(), sensitiveConfigUsed });
      return { copied, url };
    })().finally(() => shareSpin.cancel());
    const displayUrl = ui.link(url);
    liveUrl = displayUrl;
    sharedUrl = url;
    await ui.note(
      displayUrl +
        (copied ? `\n${pc.dim("Copied to clipboard.")}` : "") +
        `\n${pc.dim("Booting - your app shows up here in a few seconds.")}` +
        `\n${pc.yellow("!")} ${pc.dim("This URL is public; anyone with it can reach your dev server.")}`,
      "Shareable URL",
    );
    if (opts.open) openUrl(url);

    // 6. Sync initial contents and determine whether the profile's install is stale.
    const timings = await readTimings(dir);
    const depCount = await countDeps(dir);
    const createdFresh = bootMode === "created";
    const cachedManifest = await readManifest(name);
    if (createdFresh && Object.keys(cachedManifest).length > 0) {
      await ui.info(pc.dim("Sandbox was recreated from scratch; re-syncing all files."));
    }
    const prev: typeof cachedManifest = createdFresh ? {} : cachedManifest;
    const toUpload = changedSince(prev, files);
    const toDelete = deletedSince(prev, files, skippedUnreadable);
    const isFresh = Object.keys(prev).length === 0;
    const depsChanged = [...toUpload.map((file) => file.rel), ...toDelete].some((rel) =>
      dependencyInputMatches(profile.dependencyFiles, rel),
    );
    const configuredInstallCommand = profile.installCommand;
    const expectedInstallMarker = installMarker(configuredInstallCommand ?? "", det.toolchain);
    const installCurrent =
      configuredInstallCommand === null
        ? true
        : await resources.run((signal) =>
            remoteTextEquals(sandbox, INSTALL_MARKER_PATH, expectedInstallMarker, signal),
          );
    const willInstall = configuredInstallCommand !== null && (!installCurrent || depsChanged);
    const provisionsToolchain = needsProvisioning(det.toolchain);

    await resources.run(() =>
      writeStatus(sandbox, {
        label: "syncing files",
        base: 10,
        ceiling: willInstall || provisionsToolchain ? 25 : 60,
        etaMs: timings.sync ?? Math.min(12_000, Math.max(1_500, files.length * 10)),
      }),
    );
    const syncStart = Date.now();
    const syncSpin = ui.spinner();
    syncSpin.start(
      isFresh ? `Syncing ${files.length} files` : `Syncing ${toUpload.length} changes`,
    );
    await resources.run(() =>
      uploadFiles(sandbox, toUpload, (done, total) =>
        syncSpin.message(`Syncing ${done}/${total} files`),
      ),
    );
    await resources.run(() => removeFiles(sandbox, toDelete));
    await writeManifest(name, manifestAfterScan(prev, files, skippedUnreadable));
    const syncLabel = isFresh
      ? `Synced ${files.length} files`
      : `Synced ${toUpload.length} changes`;
    await syncSpin.stop(`${syncLabel} ${pc.dim(`· ${formatElapsed(Date.now() - syncStart)}`)}`);
    const syncMs = Date.now() - syncStart;

    // Start watching before install/start. Events coalesce while booting; a
    // mandatory reconciliation below closes both the pre-watcher gap and edits
    // made during slow commands.
    let booting = true;
    let syncing = false;
    let syncDirty = false;
    let restartAfterDependencyChange: (() => Promise<void>) | undefined;
    const syncNow = async (): Promise<{ changes: number; dependenciesChanged: boolean }> => {
      const prevManifest = await readManifest(name);
      const result = await resources.run(() =>
        reconcileFiles(sandbox, dir, prevManifest, syncOptions),
      );
      await reportSkippedPaths(result);
      await writeManifest(
        name,
        manifestAfterScan(prevManifest, result.files, result.skippedUnreadable),
      );
      return {
        changes: result.uploaded + result.deleted,
        dependenciesChanged: result.changedPaths.some((rel) =>
          dependencyInputMatches(profile.dependencyFiles, rel),
        ),
      };
    };
    const drainSyncs = () => {
      if (syncing || booting || resources.shuttingDown) return;
      syncing = true;
      void (async () => {
        try {
          while (syncDirty) {
            syncDirty = false;
            const result = await syncNow();
            if (
              result.dependenciesChanged &&
              profile.installCommand &&
              restartAfterDependencyChange
            ) {
              await restartAfterDependencyChange();
            } else if (result.changes) {
              await ui.info(pc.dim(`synced ${result.changes} change(s)`));
            }
          }
        } catch (err) {
          if (!resources.shuttingDown) {
            await ui.warn(
              `Sync failed: ${formatError(err)}. If this persists, the sandbox may have stopped; run \`up .\` to reconnect.`,
            );
          }
        } finally {
          syncing = false;
          if (syncDirty) drainSyncs();
        }
      })();
    };
    const watcher = await watchProject(dir, {
      includeSensitiveConfig,
      onFallback: (err) => {
        void ui.warn(
          `Live file watching is unavailable (${formatError(err)}). Checking for changes every 2s instead.`,
        );
      },
      onChange: (source) => {
        // Polling is already a full scan. During boot, stabilization below performs
        // that scan exactly when needed without letting periodic ticks delay ready.
        if (booting && source === "poll") return;
        syncDirty = true;
        drainSyncs();
      },
    });
    resources.addCloseable(watcher);

    // 7. Install dependencies when the command or declared dependency inputs changed.
    if (provisionsToolchain) {
      const manager = det.toolchain.packageManager ?? "toolchain";
      await resources.run(() =>
        writeStatus(sandbox, {
          label: `preparing ${manager} runtime`,
          base: 25,
          ceiling: willInstall ? 35 : 75,
          etaMs: 3000,
        }),
      );
      await provisionToolchain(ui, resources, sandbox, det.toolchain);
    }

    const appEnv = envFile?.values ?? {};
    let installMs: number | undefined;
    let installGeneration = 0;
    const installDependencies = async () => {
      const installCommand = profile.installCommand;
      if (!installCommand) return;
      await resources.run(() =>
        writeStatus(sandbox, {
          label: "installing dependencies",
          base: provisionsToolchain ? 35 : 25,
          ceiling: 90,
          etaMs: timings.install ?? installEtaFromDeps(depCount),
        }),
      );
      const installStart = Date.now();
      const installSpin = ui.spinner();
      installSpin.start("Installing dependencies");
      const recent = ring(60);
      const install = projectCommand(installCommand, det.toolchain);
      const { exitCode } = await resources.run((signal) =>
        sandbox.exec(install.cmd, install.args, {
          cwd: REMOTE_ROOT,
          env: { PORT: String(devPort) },
          onLog: (chunk) => recent.push(chunk),
          signal,
        }),
      );
      if (exitCode !== 0) {
        await installSpin.fail("Install failed");
        process.stdout.write(sanitizeTerminalText(recent.text(), { preserveNewlines: true }));
        throw new Error(`\`${installCommand}\` exited with ${exitCode}`);
      }
      await resources.run(() =>
        sandbox.writeFiles([
          { path: INSTALL_MARKER_PATH, content: installMarker(installCommand, det.toolchain) },
        ]),
      );
      const installDuration = Date.now() - installStart;
      await installSpin.stop(
        `Dependencies installed ${pc.dim(`· ${formatElapsed(installDuration)}`)}`,
      );
      installMs = (installMs ?? 0) + installDuration;
      installGeneration++;
    };
    if (willInstall) {
      await installDependencies();
    } else if (profile.installCommand) {
      await ui.info(`Dependencies reused ${pc.dim("· install skipped")}`);
    }

    const stabilizeDependencies = async () => {
      for (;;) {
        const synced = await syncNow();
        if (!synced.dependenciesChanged || !profile.installCommand) return;
        await ui.info(pc.dim("Dependency inputs changed during startup; installing updates."));
        await installDependencies();
      }
    };
    await stabilizeDependencies();

    // 8. Start the internal server; public traffic stays on the supervisor at 3000.
    await resources.run(() =>
      writeStatus(sandbox, {
        label: "starting server",
        base: willInstall ? 90 : provisionsToolchain ? 75 : 60,
        ceiling: 99,
        etaMs: timings.start ?? startEtaFor(det.slug),
      }),
    );
    const startSpin = ui.spinner();
    startSpin.start("Starting dev server");
    let recent = ring(80);
    const startedAt = Date.now();
    const dev = projectCommand(profile.devCommand, det.toolchain);
    let activeDevProc: Awaited<ReturnType<typeof sandbox.spawn>> | undefined;
    const waitForProcessExit = async (
      proc: Awaited<ReturnType<typeof sandbox.spawn>>,
      timeoutMs = 5_000,
    ): Promise<boolean> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await proc.wait(controller.signal);
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timeout);
      }
    };
    const writeReady = () =>
      resources.run(() =>
        writeStatus(
          sandbox,
          { label: "ready", base: 100, ceiling: 100, etaMs: 0, ready: true },
          { required: true },
        ),
      );

    const stopDevProcess = async (proc: Awaited<ReturnType<typeof sandbox.spawn>>) => {
      await proc.kill("SIGTERM").catch(() => {});
      if (!(await waitForProcessExit(proc))) {
        await proc.kill("SIGKILL").catch(() => {});
        await waitForProcessExit(proc, 3_000);
      }
      resources.removeProcess(proc);
    };
    const startDevProcess = async (
      spin: typeof startSpin,
      message: string,
    ): Promise<Awaited<ReturnType<typeof sandbox.spawn>>> => {
      recent = ring(80);
      spin.start(message);
      const devProc = await resources.run((signal) =>
        sandbox.spawn(dev.cmd, dev.args, {
          cwd: REMOTE_ROOT,
          env: {
            ...appEnv,
            PORT: String(devPort),
            BROWSER: "none",
            NEXT_TELEMETRY_DISABLED: "1",
            FORCE_COLOR: "1",
          },
          signal,
        }),
      );
      resources.addProcess(devProc);
      void (async () => {
        try {
          for await (const line of devProc.logs()) recent.push(line.data);
        } catch {
          // The log stream ends when its process or sandbox stops.
        }
      })();

      const started = await Promise.race([
        resources
          .run((signal) => waitForPort(sandbox, devPort, 90_000, signal))
          .then((open) => ({ type: "port" as const, open })),
        resources
          .run((signal) => devProc.wait(signal))
          .then(({ exitCode }) => ({ type: "exit" as const, exitCode })),
      ]);
      if (started.type === "exit") {
        resources.removeProcess(devProc);
        await spin.fail("Dev server exited during startup");
        process.stdout.write(sanitizeTerminalText(recent.text(), { preserveNewlines: true }));
        throw new Error(`\`${profile.devCommand}\` exited with ${started.exitCode}`);
      }
      if (!started.open) {
        await stopDevProcess(devProc);
        await spin.fail("Dev server did not become ready");
        process.stdout.write(sanitizeTerminalText(recent.text(), { preserveNewlines: true }));
        throw new Error("Timed out waiting for the dev server. See logs above.");
      }
      return devProc;
    };
    // On reconnect the dev server may still be running from the previous
    // session. Probe the port first; if it responds, reuse it instead of
    // spawning a new process that would conflict on the same port.
    let serverAlreadyRunning = false;
    if (bootMode === "reconnected") {
      serverAlreadyRunning = await resources
        .run((signal) => waitForPort(sandbox, devPort, 2_000, signal))
        .catch(() => false);
      if (serverAlreadyRunning) {
        await writeReady();
        await startSpin.stop(`Dev server running · ${displayUrl}`);
        booting = false;
      }
    }

    if (!serverAlreadyRunning) {
      for (;;) {
        const dependencyGenerationAtStart = installGeneration;
        const devProc = await startDevProcess(startSpin, "Starting dev server");
        activeDevProc = devProc;

        do {
          syncDirty = false;
          await stabilizeDependencies();
        } while (syncDirty);

        if (installGeneration === dependencyGenerationAtStart) break;
        await stopDevProcess(devProc);
        startSpin.message("Restarting dev server after dependency changes");
      }
    }
    restartAfterDependencyChange = async () => {
      if (!profile.installCommand || !activeDevProc) return;
      await ui.info(pc.dim("Dependency inputs changed; reinstalling and restarting dev server."));
      for (;;) {
        await installDependencies();
        const synced = await syncNow();
        if (!synced.dependenciesChanged) {
          if (synced.changes) await ui.info(pc.dim(`synced ${synced.changes} change(s)`));
          break;
        }
        await ui.info(pc.dim("Dependency inputs changed during install; installing updates."));
      }
      await stopDevProcess(activeDevProc);
      await resources.run(() =>
        writeStatus(sandbox, {
          label: "starting server",
          base: 90,
          ceiling: 99,
          etaMs: timings.start ?? startEtaFor(det.slug),
        }),
      );
      const restartSpin = ui.spinner();
      activeDevProc = await startDevProcess(restartSpin, "Restarting dev server");
      await writeReady();
      await restartSpin.stop(`Dev server restarted · ${displayUrl}`);
    };
    await resources.run(() =>
      writeStatus(
        sandbox,
        { label: "ready", base: 100, ceiling: 100, etaMs: 0, ready: true },
        { required: true },
      ),
    );
    booting = false;
    await startSpin.stop(
      `Dev server ready · ${displayUrl} ${pc.dim(
        `· ready in ${formatElapsed(Date.now() - bootStart)}`,
      )}`,
    );

    await recordTimings(dir, {
      sync: syncMs,
      start: Date.now() - startedAt,
      ...(installMs !== undefined ? { install: installMs } : {}),
    });
    await ui.final(pc.dim("Watching for changes. Press Ctrl-C to stop."));

    // 9. Keep the persistent sandbox active while attached.
    let keepAliveFails = 0;
    let keepAliveRunning = false;
    const keepAlive = setInterval(
      () => {
        if (keepAliveRunning || resources.shuttingDown) return;
        keepAliveRunning = true;
        const sessionBefore = sandbox.sessionId();
        void resources
          .run(() => sandbox.extendTimeout(DEFAULT_TIMEOUT_MS))
          .then(() => {
            keepAliveFails = 0;
            // extendTimeout routes through withResume, which silently
            // restarts a sandbox that was stopped out-of-band (e.g. by
            // `up stop` in another terminal). Warn when that happens.
            if (sandbox.sessionId() !== sessionBefore) {
              void ui.warn(
                "Sandbox was restarted by the keepalive after being stopped externally. Run `up stop` to stop it.",
              );
            }
          })
          .catch(() => {
            if (!resources.shuttingDown && ++keepAliveFails >= 2) {
              void ui.warn(
                "Lost contact with the sandbox; it may have stopped. Run `up .` to reconnect.",
              );
            }
          })
          .finally(() => {
            keepAliveRunning = false;
          });
      },
      10 * 60 * 1000,
    );
    keepAlive.unref();
    stopBackground = () => clearInterval(keepAlive);
  } catch (err) {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    stopBackground();
    if (resources.shuttingDown) {
      await resources.shutdown().catch(() => {});
      return;
    }
    try {
      const saved = await resources.shutdown();
      await ui.info(pc.dim(`Saved snapshot after startup failure (${saved.snapshotId}).`));
      if (sharedUrl) {
        await ui.warn(
          "Startup failed, so the shareable URL is now offline. Fix the error and run `up .` to resume this saved sandbox.",
        );
      }
    } catch (stopErr) {
      await ui.warn(`Could not save snapshot after startup failure: ${formatError(stopErr)}`);
    }
    return fail(err);
  }
}

async function runStop(input: string) {
  const ui = new TerminalFlow();
  ui.intro();
  const dir = await resolveDir(input);
  const s = ui.spinner();
  s.start("Stopping sandbox");
  try {
    await s.stop(`Snapshot saved ${pc.dim(await stopAndVerify(dir))}`);
  } catch (err) {
    await s.fail("Could not stop");
    return fail(err);
  }
}

async function stopAndVerify(dir: string): Promise<string> {
  const auth = await resolveAuth(dir);
  if (auth.kind === "anonymous") throw new Error("Not logged in.");
  const saved = await new VercelProvider().stop(
    await resolveSandboxName(dir),
    credentialsFor(auth),
  );
  if (!saved.snapshotId) {
    throw new Error(
      `stop() completed without a saved snapshot (status: ${saved.status ?? "unknown"})`,
    );
  }
  return saved.snapshotId;
}

async function runBackgroundStop(): Promise<void> {
  await stopAndVerify(process.cwd()).catch(() => {
    process.exitCode = 1;
  });
}

async function runLs() {
  const projects = await listProjects();
  if (projects.length === 0) {
    p.log.info("No up environments yet. Run `up .` in a project.");
    return;
  }
  for (const proj of projects) {
    const when = new Date(proj.updatedAt).toLocaleString();
    p.log.message(
      `${pc.bold(sanitizeTerminalText(proj.dir))}\n${pc.dim(`${sanitizeTerminalText(proj.sandbox)} · ${when}`)}`,
    );
  }
}

/** Small ring buffer for recent log output. */
function ring(max: number) {
  const lines: string[] = [];
  return {
    push(chunk: string) {
      lines.push(chunk);
      while (lines.length > max) lines.shift();
    },
    text() {
      return lines.join("");
    },
  };
}

function formatError(err: unknown): string {
  return sanitizeTerminalText(err instanceof Error ? err.message : String(err));
}

function formatPaths(paths: string[]): string {
  const visible = paths.slice(0, 3).map((rel) => pc.bold(sanitizeTerminalText(rel)));
  const remaining = paths.length - visible.length;
  return `${visible.join(", ")}${remaining > 0 ? ` and ${remaining} more` : ""}`;
}

function fail(err: unknown): never {
  p.log.error(formatError(err));
  process.exit(1);
}

/** Parse and validate the optional `--port` override (1-65535), or undefined. */
function parsePort(input: unknown): number | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    p.log.error(`Invalid --port: ${String(input)}. Use an integer between 1 and 65535.`);
    process.exit(1);
  }
  return n;
}

function parseCommand(input: unknown, flag: string): string | undefined {
  if (input === undefined || input === null) return undefined;
  const command = String(input);
  if (!command.trim()) {
    p.log.error(`Invalid ${flag}: command cannot be empty.`);
    process.exit(1);
  }
  return command;
}

function parseEnvFile(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  const file = String(input);
  if (!file.trim()) {
    p.log.error("Invalid --env-file: path cannot be empty.");
    process.exit(1);
  }
  return file;
}

const main = defineCommand({
  meta: {
    name: "up",
    description: "Instant, shareable dev environments on Vercel Sandbox",
  },
  args: {
    target: {
      type: "positional",
      required: false,
      default: ".",
      description: "Project directory (or `stop`/`ls`)",
    },
    open: { type: "boolean", description: "Open the URL in your browser" },
    "env-file": {
      type: "string",
      description: "Read a local dotenv file and inject its variables into the dev server",
    },
    "include-sensitive-config": {
      type: "boolean",
      description:
        "Upload selected credential-bearing config files such as .npmrc and .yarnrc* even if gitignored (they persist)",
    },
    port: { type: "string", description: "Override the dev server port" },
    command: { type: "string", description: "Command that starts the server (supports $PORT)" },
    "install-command": {
      type: "string",
      description: "Command that installs dependencies (empty string skips)",
    },
    "save-config": {
      type: "boolean",
      description: "Write the resolved launch profile to up.config.json",
    },
  },
  async run({ args }) {
    const target = String(args.target);
    if (target === BACKGROUND_STOP_TARGET) return runBackgroundStop();
    if (target === "stop") return runStop(".");
    if (target === "ls" || target === "list") return runLs();
    await runDev(target, {
      open: Boolean(args.open),
      envFile: parseEnvFile(args["env-file"]),
      includeSensitiveConfig: Boolean(args["include-sensitive-config"]),
      port: parsePort(args.port),
      command: parseCommand(args.command, "--command"),
      installCommand:
        args["install-command"] === undefined
          ? undefined
          : String(args["install-command"]).trim()
            ? String(args["install-command"])
            : null,
      saveConfig: Boolean(args["save-config"]),
    });
  },
});

// Don't set process.title: overwriting the argv region can leak the adjacent env
// block into `ps`/terminal titles. Unset, it shows the plain node invocation.
runMain(main);
