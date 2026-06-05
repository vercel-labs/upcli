import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  listProjects,
  readEnvFilePreference,
  readLaunchProfile,
  readManifest,
  readTimings,
  recordTimings,
  rememberEnvFilePreference,
  rememberLaunchProfile,
  rememberProject,
  rememberTrustedSharedCommands,
  resolveSandboxName,
  sandboxNameFor,
  trustsSharedCommands,
  writeManifest,
} from "../src/config.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), "dev-cfg-"));
  process.env.DEV_STATE_DIR = stateDir;
});

afterEach(async () => {
  delete process.env.DEV_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

test("recordTimings on an unknown project is a no-op", async () => {
  await recordTimings("/nope", { sync: 1 });
  expect(await readTimings("/nope")).toEqual({});
});

test("records and reads back per-project timings", async () => {
  await rememberProject({ dir: "/proj", sandbox: "dev-abc", updatedAt: 1 });
  await recordTimings("/proj", { sync: 100, install: 200 });
  expect(await readTimings("/proj")).toEqual({ sync: 100, install: 200 });
});

test("recordTimings merges instead of replacing", async () => {
  await rememberProject({ dir: "/proj", sandbox: "dev-abc", updatedAt: 1 });
  await recordTimings("/proj", { sync: 100 });
  await recordTimings("/proj", { start: 300 });
  expect(await readTimings("/proj")).toEqual({ sync: 100, start: 300 });
});

test("rememberProject preserves previously recorded timings", async () => {
  await rememberProject({ dir: "/proj", sandbox: "dev-abc", updatedAt: 1 });
  await recordTimings("/proj", { sync: 100, install: 200, start: 300 });
  // A later run re-remembers the project with a fresh timestamp.
  await rememberProject({ dir: "/proj", sandbox: "dev-abc", updatedAt: 999 });
  expect(await readTimings("/proj")).toEqual({ sync: 100, install: 200, start: 300 });
  const proj = (await listProjects())[0];
  expect(proj?.updatedAt).toBe(999);
});

test("remembers a local launch profile alongside project state", async () => {
  await rememberProject({ dir: "/proj", sandbox: "dev-abc", updatedAt: 1 });
  await rememberLaunchProfile("/proj", {
    installCommand: null,
    devCommand: "python3 -m http.server $PORT",
    port: 8080,
    dependencyFiles: [],
  });
  expect(await readLaunchProfile("/proj")).toEqual({
    installCommand: null,
    devCommand: "python3 -m http.server $PORT",
    port: 8080,
    dependencyFiles: [],
  });
});

test("remembers a local env-file decision alongside project state", async () => {
  await rememberProject({ dir: "/proj", sandbox: "dev-abc", updatedAt: 1 });
  await rememberEnvFilePreference("/proj", ".env.local");
  expect(await readEnvFilePreference("/proj")).toBe(".env.local");

  await rememberEnvFilePreference("/proj", null);
  expect(await readEnvFilePreference("/proj")).toBeNull();
});

test("scopes new sandbox names to the local installation and preserves existing records", async () => {
  const first = await resolveSandboxName("/proj");
  const second = await resolveSandboxName("/proj");
  expect(first).toBe(second);
  expect(first).toBe(
    sandboxNameFor(
      "/proj",
      JSON.parse(await readFile(path.join(stateDir, "installation.json"), "utf8")).id,
    ),
  );

  await rememberProject({ dir: "/legacy", sandbox: "dev-legacy", updatedAt: 1 });
  expect(await resolveSandboxName("/legacy")).toBe("dev-legacy");
});

test("uses different names for the same path across installations", async () => {
  const first = await resolveSandboxName("/proj");
  const otherStateDir = await mkdtemp(path.join(os.tmpdir(), "dev-cfg-other-"));
  process.env.DEV_STATE_DIR = otherStateDir;
  try {
    expect(await resolveSandboxName("/proj")).not.toBe(first);
  } finally {
    await rm(otherStateDir, { recursive: true, force: true });
  }
});

test("ignores malformed env-file preference from local state", async () => {
  await rememberProject({ dir: "/proj", sandbox: "dev-abc", updatedAt: 1 });
  const file = path.join(stateDir, "projects.json");
  const store = JSON.parse(await readFile(file, "utf8"));
  store.projects["/proj"].envFile = { path: ".env.local" };
  await writeFile(file, JSON.stringify(store));

  expect(await readEnvFilePreference("/proj")).toBeUndefined();
});

test("trusts shared commands only for the approved command and sensitive-input mode", async () => {
  const profile = {
    installCommand: "npm install",
    devCommand: "npm run dev",
    port: 3000,
    dependencyFiles: ["package.json"],
  };
  await rememberTrustedSharedCommands("/proj", profile, false);

  expect(await trustsSharedCommands("/proj", profile, false)).toBe(true);
  expect(await trustsSharedCommands("/proj", profile, true)).toBe(false);
  expect(await trustsSharedCommands("/proj", profile, false, true)).toBe(false);
  expect(
    await trustsSharedCommands("/proj", { ...profile, devCommand: "npm run compromised" }, false),
  ).toBe(false);
  expect(
    await trustsSharedCommands("/proj", { ...profile, dependencyFiles: ["**/*"] }, false),
  ).toBe(false);
});

test("does not accept a malformed trusted-command list from local state", async () => {
  const profile = {
    installCommand: null,
    devCommand: "npm run dev",
    port: 3000,
    dependencyFiles: [],
  };
  await rememberTrustedSharedCommands("/proj", profile, false);
  const file = path.join(stateDir, "projects.json");
  const store = JSON.parse(await readFile(file, "utf8"));
  store.projects["/proj"].trustedSharedCommandKeys =
    store.projects["/proj"].trustedSharedCommandKeys[0];
  await writeFile(file, JSON.stringify(store));

  expect(await trustsSharedCommands("/proj", profile, false)).toBe(false);
});

test("writes are atomic: no .tmp residue, store stays valid JSON", async () => {
  for (let i = 0; i < 5; i++) {
    await rememberProject({ dir: `/p${i}`, sandbox: `dev-${i}`, updatedAt: i });
    await recordTimings(`/p${i}`, { sync: i, install: i * 2 });
  }
  const entries = await readdir(stateDir);
  expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  const raw = await readFile(path.join(stateDir, "projects.json"), "utf8");
  expect(() => JSON.parse(raw)).not.toThrow();
  expect((await listProjects()).length).toBe(5);
});

test("writes local state and manifests with owner-only file permissions", async () => {
  if (process.platform === "win32") return;
  await rememberProject({ dir: "/proj", sandbox: "dev-abc", updatedAt: 1 });
  await resolveSandboxName("/fresh");
  await writeManifest("dev-abc", { "src/index.ts": { size: 10, mtimeMs: 3 } });

  expect((await stat(path.join(stateDir, "projects.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(path.join(stateDir, "installation.json"))).mode & 0o777).toBe(0o600);
  expect(await readManifest("dev-abc")).toEqual({ "src/index.ts": { size: 10, mtimeMs: 3 } });
  const files = await readdir(stateDir);
  const manifestFile = files.find((file) => file.endsWith(".manifest.json"));
  expect(manifestFile).toBeDefined();
  expect((await stat(path.join(stateDir, manifestFile as string))).mode & 0o777).toBe(0o600);
});

test("does not overwrite a malformed project store", async () => {
  const file = path.join(stateDir, "projects.json");
  await writeFile(file, "{broken");
  await expect(rememberProject({ dir: "/proj", sandbox: "dev-abc", updatedAt: 1 })).rejects.toThrow(
    "Could not read state",
  );
  expect(await readFile(file, "utf8")).toBe("{broken");
});

test("rejects valid JSON without the required project map", async () => {
  await writeFile(path.join(stateDir, "projects.json"), "{}");
  await expect(listProjects()).rejects.toThrow("expected an object with a projects map");
});
