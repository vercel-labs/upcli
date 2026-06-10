import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Framework } from "@vercel/frameworks";
import { frameworks } from "@vercel/frameworks";
import { detectFrameworkRecord } from "@vercel/fs-detectors/dist/detect-framework.js";
import { LocalFileSystemDetector } from "@vercel/fs-detectors/dist/detectors/local-file-system-detector.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface RuntimeToolchain {
  /** Package manager that must be available in the remote sandbox. */
  packageManager?: PackageManager;
  /** Exact or declared version when the remote runtime should not rely on the base image. */
  version?: string;
}

/** A portable description of how to boot one working directory. */
export interface LaunchProfile {
  /** Shell command executed once when dependencies need installing; null skips install. */
  installCommand: string | null;
  /** Shell command executed as the long-running server. `$PORT` is available in its environment. */
  devCommand: string;
  /** Preferred server port before the public-supervisor collision adjustment. */
  port: number;
  /** Relative files whose edits invalidate an installed dependency set. */
  dependencyFiles: string[];
}

export interface Detected {
  /** Framework slug (e.g. "nextjs", "vite"), or null if unknown. */
  slug: string | null;
  /** Human-readable detected project kind/framework. */
  name: string;
  packageManager: PackageManager;
  kind: "node" | "python" | "static" | "custom";
  /** Recommended port even when interactive configuration is required. */
  suggestedPort: number;
  /** Fully automatic profile when it is safe to infer a start command. */
  profile: LaunchProfile | null;
  /** Tools the sandbox runtime must provide for detected project commands. */
  toolchain: RuntimeToolchain;
  /** Suggested installation command available to interactive/custom configuration. */
  suggestedInstallCommand: string | null;
  dependencyFiles: string[];
}

/** Default dev-server ports by framework slug. Falls back to 3000. */
export const DEFAULT_PORTS: Record<string, number> = {
  vite: 5173,
  sveltekit: 5173,
  "sveltekit-1": 5173,
  astro: 4321,
  gatsby: 8000,
  angular: 4200,
  vue: 8080,
  eleventy: 8080,
  preact: 8080,
  fastapi: 8080,
  flask: 8080,
  fasthtml: 8080,
  django: 8080,
  python: 8080,
};

interface FrameworkDevHint {
  slug: string | null;
  settings?: { devCommand?: { value?: string | null } };
}

/**
 * The exact port argument a framework's dev server needs, derived from its own
 * dev-command template in `@vercel/frameworks` (the flag token before `$PORT`,
 * e.g. vite's `--port $PORT` or storybook's `-p $PORT`). Frameworks that honor
 * the `PORT` env var have no `$PORT` in their template and need no flag.
 * Deriving this keeps it correct as frameworks are added, instead of a
 * hand-maintained list that drifts and leaves new frameworks binding to their
 * own default port while the supervisor waits on the expected one.
 */
const PORT_FLAG_BY_SLUG: ReadonlyMap<string, string> = new Map(
  (frameworks as unknown as readonly FrameworkDevHint[]).flatMap((framework) => {
    const tokens = (framework.settings?.devCommand?.value ?? "").split(/\s+/);
    const at = tokens.indexOf("$PORT");
    const flag = at > 0 ? tokens[at - 1] : undefined;
    return framework.slug && flag?.startsWith("-")
      ? [[framework.slug, `${flag} $PORT`] as const]
      : [];
  }),
);

/** The `--port`/`-p` argument to forward to a framework's dev script, if it needs one. */
export function portFlagForSlug(slug: string | null): string | undefined {
  return slug ? PORT_FLAG_BY_SLUG.get(slug) : undefined;
}

const PYTHON_SLUGS = new Set(["fastapi", "flask", "fasthtml", "django", "python"]);

const LOCKFILES_BY_MANAGER: Record<PackageManager, string[]> = {
  bun: ["bun.lock", "bun.lockb"],
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
};

const NODE_DEPENDENCY_FILES = [
  "package.json",
  ...LOCKFILES_BY_MANAGER.npm,
  ...LOCKFILES_BY_MANAGER.pnpm,
  ...LOCKFILES_BY_MANAGER.yarn,
  ...LOCKFILES_BY_MANAGER.bun,
];

const NODE_DEPENDENCY_GLOBS = NODE_DEPENDENCY_FILES.map((file) => `**/${file}`);
const NODE_WORKSPACE_FILES = [
  "pnpm-workspace.yaml",
  "nx.json",
  "turbo.json",
  "lerna.json",
  "rush.json",
];

const PYTHON_DEPENDENCY_FILES = [
  "requirements.txt",
  "pyproject.toml",
  "uv.lock",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
];

const PM_LOCKFILES: Array<[PackageManager, string]> = [
  ...LOCKFILES_BY_MANAGER.bun.map((file) => ["bun", file] as [PackageManager, string]),
  ...LOCKFILES_BY_MANAGER.pnpm.map((file) => ["pnpm", file] as [PackageManager, string]),
  ...LOCKFILES_BY_MANAGER.yarn.map((file) => ["yarn", file] as [PackageManager, string]),
  ...LOCKFILES_BY_MANAGER.npm.map((file) => ["npm", file] as [PackageManager, string]),
];

/** Tested fallback versions for lockfile-only projects with no fixed toolchain declaration. */
export const DEFAULT_BUN_VERSION = "1.3.14";
export const DEFAULT_PNPM_VERSION = "10.23.0";
export const DEFAULT_YARN_VERSION = "1.22.22";

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

async function anyFileExists(dir: string, relPaths: string[]): Promise<boolean> {
  for (const rel of relPaths) {
    if (await fileExists(path.join(dir, rel))) return true;
  }
  return false;
}

async function hasLockfileFor(dir: string, packageManager: PackageManager): Promise<boolean> {
  return await anyFileExists(dir, LOCKFILES_BY_MANAGER[packageManager]);
}

interface PackageJson {
  scripts?: Record<string, string>;
  packageManager?: string;
  workspaces?: unknown;
}

interface DeclaredPackageManager {
  packageManager: PackageManager;
  /** Exact version/spec only when it is safe to provision deterministically. */
  version?: string;
}

function declaredPackageManager(pkg: PackageJson | null): DeclaredPackageManager | undefined {
  const value = pkg?.packageManager;
  if (typeof value !== "string") return undefined;
  const match = /^(npm|pnpm|yarn|bun)@(.+)$/.exec(value);
  const manager = match?.[1];
  if (!manager) return undefined;
  const versionSpec = match[2];
  const version = versionSpec ? fixedPackageManagerVersion(versionSpec) : undefined;
  return version
    ? { packageManager: manager as PackageManager, version }
    : { packageManager: manager as PackageManager };
}

function fixedPackageManagerVersion(value: string): string | undefined {
  // Package managers allow broader specs, but provisioning a persistent sandbox
  // should be deterministic. Keep the full build metadata for corepack specs
  // while rejecting tags/ranges such as `latest` or `10`.
  return /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : undefined;
}

function toolchainFor(pkg: PackageJson | null, packageManager: PackageManager): RuntimeToolchain {
  const declared = declaredPackageManager(pkg);
  const declaredVersion =
    declared?.packageManager === packageManager ? declared.version : undefined;
  switch (packageManager) {
    case "bun":
      return { packageManager, version: declaredVersion ?? DEFAULT_BUN_VERSION };
    case "pnpm":
      return { packageManager, version: declaredVersion ?? DEFAULT_PNPM_VERSION };
    case "yarn":
      return { packageManager, version: declaredVersion ?? DEFAULT_YARN_VERSION };
    case "npm":
      return declaredVersion ? { packageManager, version: declaredVersion } : {};
  }
}

/** Detect the package manager from packageManager/lockfiles; defaults to npm. */
export async function detectPackageManager(
  dir: string,
  pkg: PackageJson | null = null,
): Promise<PackageManager> {
  const declared = declaredPackageManager(pkg ?? (await readPackageJson(dir)));
  if (declared) return declared.packageManager;
  for (const [pm, lockfile] of PM_LOCKFILES) {
    if (await fileExists(path.join(dir, lockfile))) return pm;
  }
  return "npm";
}

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  const file = path.join(dir, "package.json");
  try {
    // Bounded like every detection read: an oversized package.json is treated
    // as absent rather than buffered into memory before the trust prompt.
    if ((await stat(file)).size > MAX_DETECT_FILE_BYTES) return null;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function nodeDependencyFiles(dir: string, pkg: PackageJson | null): Promise<string[]> {
  const hasWorkspaces =
    Array.isArray(pkg?.workspaces) ||
    (pkg?.workspaces !== null && typeof pkg?.workspaces === "object") ||
    (await anyFileExists(dir, NODE_WORKSPACE_FILES));
  return hasWorkspaces
    ? [...NODE_DEPENDENCY_FILES, ...NODE_DEPENDENCY_GLOBS, ...NODE_WORKSPACE_FILES]
    : NODE_DEPENDENCY_FILES;
}

function portFor(slug: string | null): number {
  return slug ? (DEFAULT_PORTS[slug] ?? 3000) : 3000;
}

async function pythonInstallCommand(dir: string): Promise<string | null> {
  if (await fileExists(path.join(dir, "requirements.txt"))) {
    return "python3 -m pip install -r requirements.txt";
  }
  if (await fileExists(path.join(dir, "pyproject.toml"))) {
    return "python3 -m pip install .";
  }
  return null;
}

function installCommandText(pm: PackageManager, hasLockfile: boolean): string {
  const install = installCommand(pm, hasLockfile);
  return [install.cmd, ...install.args].join(" ");
}

/**
 * The port a dev script binds explicitly, so the supervisor waits on the port
 * the server actually uses instead of the framework default. Recognizes the
 * common forms `--port 4000`, `--port=4000`, `-p 4000` (Next.js, Storybook)
 * and a leading `PORT=4000` env assignment. Without this, a hardcoded port
 * silently mismatches the default and boot times out.
 */
export function portFromDevScript(script: string): number | undefined {
  const patterns = [
    /(?<![\w-])--port[=\s]+(\d{1,5})(?![\d.])/,
    /(?<![\w-])-p[=\s]+(\d{1,5})(?![\d.])/,
    /(?:^|\s)PORT=(\d{1,5})(?![\d.])/,
  ];
  for (const re of patterns) {
    const match = re.exec(script);
    if (!match?.[1]) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  }
  return undefined;
}

function scriptCommand(pm: PackageManager): string {
  // PORT is always injected as an env var at spawn time; modern frameworks
  // (Next.js, Vite, SvelteKit, Nuxt, …) read it automatically. Passing
  // `-- --port` breaks frameworks like Next.js that treat `--` as the end of
  // flag parsing and interpret `--port` as a project directory path.
  return `${pm} run dev`;
}

async function nodeProfile(
  dir: string,
  packageManager: PackageManager,
  toolchain: RuntimeToolchain,
  slug: string | null,
  name: string,
  devCommand: string,
  dependencyFiles: string[],
  portOverride?: number,
): Promise<Detected> {
  const install = installCommandText(packageManager, await hasLockfileFor(dir, packageManager));
  const suggestedPort = portOverride ?? portFor(slug);
  return {
    slug,
    name,
    packageManager,
    kind: "node",
    suggestedPort,
    toolchain,
    suggestedInstallCommand: install,
    dependencyFiles,
    profile: {
      installCommand: install,
      devCommand,
      port: suggestedPort,
      dependencyFiles,
    },
  };
}

/**
 * Cap how much any single file read buffers during detection. A cloned repo is
 * untrusted and scanned (package.json, index.js, server.ts, Cargo.toml, ...)
 * before any trust prompt, so an oversized file must not be read whole into
 * memory. 4 MB is far above any real detection input and far below OOM.
 */
export const MAX_DETECT_FILE_BYTES = 4 * 1024 * 1024;

/**
 * A filesystem detector that treats an oversized file as empty (its detectors
 * simply do not match) instead of buffering it whole. Mirrors the parent's
 * path resolution because that is private; detection never `_chdir`s, so only
 * the root reader needs bounding.
 */
class BoundedFileSystemDetector extends LocalFileSystemDetector {
  constructor(private readonly boundRoot: string) {
    super(boundRoot);
  }

  async _readFile(name: string): Promise<Buffer> {
    const rel = name.startsWith(this.boundRoot) ? path.relative(this.boundRoot, name) : name;
    const file = path.join(this.boundRoot, rel);
    const { size } = await stat(file);
    return size > MAX_DETECT_FILE_BYTES ? Buffer.alloc(0) : readFile(file);
  }
}

/**
 * Detect a conservative automatic launch profile. Node projects with an
 * existing `scripts.dev` or framework template are automatic. Python is only
 * automatic when serving static files or an obvious Django `manage.py`;
 * FastAPI, Flask and arbitrary entrypoints need a saved/entered command.
 */
export async function detect(dir: string): Promise<Detected> {
  const fs = new BoundedFileSystemDetector(dir);
  const record = await detectFrameworkRecord({
    fs,
    frameworkList: frameworks as unknown as readonly Framework[],
  });
  const slug = record?.slug ?? null;
  const pkg = await readPackageJson(dir);
  const packageManager = await detectPackageManager(dir, pkg);
  const toolchain = toolchainFor(pkg, packageManager);
  const suggestedPort = portFor(slug);
  const detectedPython = PYTHON_SLUGS.has(slug ?? "");

  if (pkg?.scripts?.dev) {
    const dependencyFiles = await nodeDependencyFiles(dir, pkg);
    const nodeSlug = detectedPython ? null : slug;
    const scriptPort =
      typeof pkg.scripts.dev === "string" ? portFromDevScript(pkg.scripts.dev) : undefined;
    return nodeProfile(
      dir,
      packageManager,
      toolchain,
      nodeSlug,
      detectedPython ? "Node.js" : (record?.name ?? "Node.js"),
      scriptCommand(packageManager),
      dependencyFiles,
      scriptPort,
    );
  }

  const hasPythonDependencies = await anyFileExists(dir, PYTHON_DEPENDENCY_FILES);
  const isPython = detectedPython || hasPythonDependencies;
  const hasDjangoEntry = await fileExists(path.join(dir, "manage.py"));
  const pythonInstall = isPython ? await pythonInstallCommand(dir) : null;

  if (hasDjangoEntry && (isPython || slug === "django")) {
    return {
      slug: slug ?? "django",
      name: record?.name ?? "Django",
      packageManager,
      kind: "python",
      suggestedPort: slug ? portFor(slug) : 8080,
      toolchain: {},
      suggestedInstallCommand: pythonInstall,
      dependencyFiles: PYTHON_DEPENDENCY_FILES,
      profile: {
        installCommand: pythonInstall,
        devCommand: 'python3 manage.py runserver "0.0.0.0:$PORT"',
        port: slug ? portFor(slug) : 8080,
        dependencyFiles: PYTHON_DEPENDENCY_FILES,
      },
    };
  }

  if (isPython) {
    return {
      slug,
      name: record?.name ?? "Python",
      packageManager,
      kind: "python",
      suggestedPort: slug ? portFor(slug) : 8080,
      toolchain: {},
      suggestedInstallCommand: pythonInstall,
      dependencyFiles: PYTHON_DEPENDENCY_FILES,
      profile: null,
    };
  }

  const template = record?.settings.devCommand.value;
  if (pkg && template) {
    const dependencyFiles = await nodeDependencyFiles(dir, pkg);
    return nodeProfile(
      dir,
      packageManager,
      toolchain,
      slug,
      record?.name ?? "Node.js",
      template,
      dependencyFiles,
    );
  }

  if (await fileExists(path.join(dir, "index.html"))) {
    return {
      slug: null,
      name: "Static files",
      packageManager,
      kind: "static",
      suggestedPort: 8080,
      toolchain: {},
      suggestedInstallCommand: null,
      dependencyFiles: [],
      profile: {
        installCommand: null,
        devCommand: 'python3 -m http.server "$PORT" --bind 0.0.0.0',
        port: 8080,
        dependencyFiles: [],
      },
    };
  }

  return {
    slug,
    name: record?.name ?? "Custom project",
    packageManager,
    kind: "custom",
    suggestedPort,
    toolchain,
    suggestedInstallCommand: null,
    dependencyFiles: [],
    profile: null,
  };
}

/** Execute a persisted/profile command through a login shell with `$PORT` available. */
export function shellInvocation(command: string): { cmd: string; args: string[] } {
  return { cmd: "bash", args: ["-lc", command] };
}

/** Install command for the detected package manager (frozen when a lockfile exists). */
export function installCommand(
  pm: PackageManager,
  hasLockfile: boolean,
): { cmd: string; args: string[] } {
  switch (pm) {
    case "pnpm":
      return { cmd: "pnpm", args: hasLockfile ? ["install", "--frozen-lockfile"] : ["install"] };
    case "yarn":
      return { cmd: "yarn", args: hasLockfile ? ["install", "--frozen-lockfile"] : ["install"] };
    case "bun":
      return {
        cmd: "bun",
        args: hasLockfile ? ["install", "--frozen-lockfile"] : ["install"],
      };
    default:
      return { cmd: "npm", args: hasLockfile ? ["ci"] : ["install"] };
  }
}
