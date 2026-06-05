import { type RuntimeToolchain, shellInvocation } from "./detect.js";
import type { SandboxLifecycle } from "./lifecycle.js";
import type { DevSandbox } from "./sandbox.js";
import { REMOTE_ROOT } from "./sync.js";
import { sanitizeTerminalText, type TerminalFlow } from "./ui.js";

export const DEV_TOOLS_ROOT = `${REMOTE_ROOT}/.dev-tools`;
const DEV_TOOLS_BIN = `${DEV_TOOLS_ROOT}/bin`;
const DEFAULT_COREPACK_VERSION = "0.34.0";
const COREPACK_ROOT = `${DEV_TOOLS_ROOT}/corepack-${DEFAULT_COREPACK_VERSION}`;
const COREPACK_BIN = `${COREPACK_ROOT}/node_modules/.bin/corepack`;

export function needsProvisioning(toolchain: RuntimeToolchain): boolean {
  return Boolean(toolchain.packageManager && toolchain.version);
}

export function toolchainFingerprint(toolchain: RuntimeToolchain): string {
  if (!toolchain.packageManager) return "dev-toolchain:none";
  return `dev-${toolchain.packageManager}@${toolchain.version ?? "runtime"}`;
}

export function installMarker(command: string, toolchain: RuntimeToolchain): string {
  return `${command}\n${toolchainFingerprint(toolchain)}`;
}

export function projectCommand(command: string, toolchain: RuntimeToolchain = {}) {
  const toolPrefix = needsProvisioning(toolchain) ? `${DEV_TOOLS_BIN}:` : "";
  const pathPrefix = `${toolPrefix}${REMOTE_ROOT}/node_modules/.bin`;
  return shellInvocation(`export PATH=${JSON.stringify(pathPrefix)}:"$PATH"; ${command}`);
}

function expectedVersion(version: string): string {
  return version.split("+")[0] ?? version;
}

async function runProvisionScript(
  ui: TerminalFlow,
  resources: SandboxLifecycle,
  sandbox: DevSandbox,
  label: string,
  script: string,
  env: Record<string, string>,
): Promise<void> {
  const spin = ui.spinner();
  spin.start(label);
  const recent: string[] = [];
  const { exitCode } = await resources.run((signal) =>
    sandbox.exec("bash", ["-lc", script], {
      env,
      onLog: (chunk) => {
        recent.push(chunk);
        while (recent.length > 40) recent.shift();
      },
      signal,
    }),
  );
  if (exitCode !== 0) {
    await spin.fail(`Could not prepare ${label.toLowerCase()}`);
    process.stdout.write(sanitizeTerminalText(recent.join(""), { preserveNewlines: true }));
    throw new Error(`Could not provision ${label} inside the sandbox.`);
  }
  await spin.stop(`${label} ready`);
}

function bunScript(): string {
  return [
    "set -eu",
    'mkdir -p "$DEV_TOOLS_BIN"',
    'if [ -x "$DEV_TOOLS_BIN/bun" ] && [ "$("$DEV_TOOLS_BIN/bun" --version)" = "$DEV_BUN_VERSION" ]; then exit 0; fi',
    'tmp="$(mktemp -d)"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    `curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v\${DEV_BUN_VERSION}/bun-linux-x64.zip" -o "$tmp/bun.zip"`,
    'python3 -m zipfile -e "$tmp/bun.zip" "$tmp"',
    'cp "$tmp/bun-linux-x64/bun" "$DEV_TOOLS_BIN/bun"',
    'chmod 755 "$DEV_TOOLS_BIN/bun"',
    'test "$("$DEV_TOOLS_BIN/bun" --version)" = "$DEV_BUN_VERSION"',
  ].join("\n");
}

function corepackScript(): string {
  return [
    "set -eu",
    'mkdir -p "$DEV_TOOLS_BIN"',
    'if ! [ -x "$COREPACK_BIN" ]; then npm install --no-audit --no-fund --prefix "$COREPACK_ROOT" "corepack@$DEV_COREPACK_VERSION"; fi',
    '"$COREPACK_BIN" enable --install-directory "$DEV_TOOLS_BIN"',
    '"$COREPACK_BIN" prepare "$DEV_TOOL_SPEC" --activate',
    'test "$("$DEV_TOOLS_BIN/$DEV_PACKAGE_MANAGER" --version)" = "$DEV_TOOL_VERSION"',
  ].join("\n");
}

function npmScript(): string {
  return [
    "set -eu",
    'mkdir -p "$DEV_TOOLS_BIN"',
    'if [ -x "$DEV_TOOLS_BIN/npm" ] && [ "$("$DEV_TOOLS_BIN/npm" --version)" = "$DEV_NPM_VERSION" ]; then exit 0; fi',
    'rm -rf "$NPM_ROOT"',
    'npm install --no-audit --no-fund --prefix "$NPM_ROOT" "npm@$DEV_NPM_VERSION"',
    'ln -sf "$NPM_ROOT/node_modules/.bin/npm" "$DEV_TOOLS_BIN/npm"',
    'test "$("$DEV_TOOLS_BIN/npm" --version)" = "$DEV_NPM_VERSION"',
  ].join("\n");
}

export async function provisionToolchain(
  ui: TerminalFlow,
  resources: SandboxLifecycle,
  sandbox: DevSandbox,
  toolchain: RuntimeToolchain,
): Promise<void> {
  const manager = toolchain.packageManager;
  if (!manager || !needsProvisioning(toolchain)) return;
  if (!toolchain.version) {
    throw new Error(`Cannot provision ${manager} without a version.`);
  }
  if (manager === "bun") {
    await runProvisionScript(ui, resources, sandbox, `Bun ${toolchain.version}`, bunScript(), {
      DEV_TOOLS_BIN,
      DEV_BUN_VERSION: expectedVersion(toolchain.version),
    });
    return;
  }
  if (manager === "npm") {
    await runProvisionScript(ui, resources, sandbox, `npm ${toolchain.version}`, npmScript(), {
      DEV_TOOLS_BIN,
      DEV_NPM_VERSION: expectedVersion(toolchain.version),
      NPM_ROOT: `${DEV_TOOLS_ROOT}/npm-${toolchain.version}`,
    });
    return;
  }
  await runProvisionScript(
    ui,
    resources,
    sandbox,
    `${manager} ${toolchain.version}`,
    corepackScript(),
    {
      COREPACK_BIN,
      COREPACK_ROOT,
      DEV_COREPACK_VERSION: DEFAULT_COREPACK_VERSION,
      DEV_PACKAGE_MANAGER: manager,
      DEV_TOOLS_BIN,
      DEV_TOOL_SPEC: `${manager}@${toolchain.version}`,
      DEV_TOOL_VERSION: expectedVersion(toolchain.version),
    },
  );
}
