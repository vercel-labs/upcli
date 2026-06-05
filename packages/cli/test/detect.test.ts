import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BUN_VERSION,
  DEFAULT_PNPM_VERSION,
  DEFAULT_YARN_VERSION,
  detect,
  detectPackageManager,
  installCommand,
  portFlagForSlug,
  shellInvocation,
} from "../src/detect.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dev-detect-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, content: string) {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe("detectPackageManager", () => {
  it("defaults to npm with no lockfile", async () => {
    expect(await detectPackageManager(dir)).toBe("npm");
  });
  it("detects pnpm", async () => {
    await write("pnpm-lock.yaml", "");
    expect(await detectPackageManager(dir)).toBe("pnpm");
  });
  it("detects bun", async () => {
    await write("bun.lock", "");
    expect(await detectPackageManager(dir)).toBe("bun");
  });
  it("prefers an explicit packageManager declaration over stale lockfiles", async () => {
    await write("package.json", JSON.stringify({ packageManager: "bun@1.2.19" }));
    await write("package-lock.json", "{}");
    expect(await detectPackageManager(dir)).toBe("bun");
  });

  it("detects npm from npm-shrinkwrap.json", async () => {
    await write("npm-shrinkwrap.json", "{}");
    expect(await detectPackageManager(dir)).toBe("npm");
  });

  it("keeps non-fixed packageManager declarations without treating tags as versions", async () => {
    await write("package.json", JSON.stringify({ packageManager: "npm@latest" }));
    const d = await detect(dir);
    expect(d.packageManager).toBe("npm");
    expect(d.toolchain).toEqual({});
  });
});

describe("automatic profiles", () => {
  it("keeps an existing Next.js dev script automatic", async () => {
    await write(
      "package.json",
      JSON.stringify({
        dependencies: { next: "15.0.0", react: "19.0.0" },
        scripts: { dev: "next dev" },
      }),
    );
    await write("package-lock.json", "{}");
    const d = await detect(dir);
    expect(d.slug).toBe("nextjs");
    expect(d.kind).toBe("node");
    expect(d.profile).toMatchObject({
      installCommand: "npm ci",
      devCommand: "npm run dev",
      port: 3000,
    });
  });

  it("does not use a foreign lockfile to choose a frozen install", async () => {
    await write(
      "package.json",
      JSON.stringify({
        packageManager: "npm@10.9.0",
        scripts: { dev: "next dev" },
      }),
    );
    await write("yarn.lock", "");
    const d = await detect(dir);
    expect(d.profile?.installCommand).toBe("npm install");
  });

  it("provisions a declared Bun version for a Bun Next.js project", async () => {
    await write(
      "package.json",
      JSON.stringify({
        packageManager: "bun@1.2.19",
        dependencies: { next: "15.0.0", react: "19.0.0" },
        scripts: { dev: "next dev" },
      }),
    );
    await write("bun.lock", "");
    const d = await detect(dir);
    expect(d.packageManager).toBe("bun");
    expect(d.toolchain).toEqual({ packageManager: "bun", version: "1.2.19" });
    expect(d.profile).toMatchObject({
      installCommand: "bun install --frozen-lockfile",
      devCommand: "bun run dev",
    });
  });

  it("uses the tested Bun version when only a Bun lockfile is present", async () => {
    await write("package.json", JSON.stringify({ scripts: { dev: "next dev" } }));
    await write("bun.lock", "");
    const d = await detect(dir);
    expect(d.toolchain).toEqual({ packageManager: "bun", version: DEFAULT_BUN_VERSION });
  });

  it("provisions a fixed pnpm fallback when only a pnpm lockfile is present", async () => {
    await write("package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    await write("pnpm-lock.yaml", "");
    const d = await detect(dir);
    expect(d.toolchain).toEqual({ packageManager: "pnpm", version: DEFAULT_PNPM_VERSION });
  });

  it("provisions a fixed Yarn fallback when only a Yarn lockfile is present", async () => {
    await write("package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    await write("yarn.lock", "");
    const d = await detect(dir);
    expect(d.toolchain).toEqual({ packageManager: "yarn", version: DEFAULT_YARN_VERSION });
  });

  it("tracks nested dependency inputs for workspace projects", async () => {
    await write(
      "package.json",
      JSON.stringify({ scripts: { dev: "next dev" }, workspaces: ["apps/*"] }),
    );
    const d = await detect(dir);
    expect(d.profile?.dependencyFiles).toContain("**/package.json");
    expect(d.profile?.dependencyFiles).toContain("**/pnpm-lock.yaml");
    expect(d.profile?.dependencyFiles).toContain("pnpm-workspace.yaml");
  });

  it("passes a reliable port variable to Vite scripts", async () => {
    await write(
      "package.json",
      JSON.stringify({ devDependencies: { vite: "5.0.0" }, scripts: { dev: "vite" } }),
    );
    await write("vite.config.js", "export default {}");
    await write("pnpm-lock.yaml", "");
    const d = await detect(dir);
    expect(d.slug).toBe("vite");
    expect(d.profile).toMatchObject({
      devCommand: "pnpm run dev",
      port: 5173,
    });
  });

  it("keeps a Node dev script automatic when Python tooling files coexist", async () => {
    await write("package.json", JSON.stringify({ scripts: { dev: "node server.js" } }));
    await write("requirements.txt", "ruff==0.5.0\n");
    const d = await detect(dir);
    expect(d.kind).toBe("node");
    expect(d.profile?.devCommand).toBe("npm run dev");
    expect(d.profile?.port).toBe(3000);
  });

  it.each([
    ["@vue/cli-service", "vue"],
    ["@11ty/eleventy", "eleventy"],
    ["preact-cli", "preact"],
  ])("uses 8080 for %s projects", async (dependency, slug) => {
    await write(
      "package.json",
      JSON.stringify({ dependencies: { [dependency]: "latest" }, scripts: { dev: "serve" } }),
    );
    const d = await detect(dir);
    expect(d.slug).toBe(slug);
    expect(d.profile?.port).toBe(8080);
  });

  it("serves a static directory on 8080 without prompting", async () => {
    await write("index.html", "<h1>static</h1>");
    const d = await detect(dir);
    expect(d.kind).toBe("static");
    expect(d.profile).toMatchObject({
      installCommand: null,
      port: 8080,
      devCommand: 'python3 -m http.server "$PORT" --bind 0.0.0.0',
    });
  });

  it("automatically starts obvious Django projects on 8080", async () => {
    await write("requirements.txt", "Django==5.0\n");
    await write("manage.py", "# django entrypoint\n");
    const d = await detect(dir);
    expect(d.kind).toBe("python");
    expect(d.profile).toMatchObject({
      port: 8080,
      devCommand: 'python3 manage.py runserver "0.0.0.0:$PORT"',
    });
  });

  it("does not guess a FastAPI or custom Python entrypoint", async () => {
    await write("requirements.txt", "fastapi==0.100\nuvicorn==0.20\n");
    await write("app.py", "from fastapi import FastAPI\n");
    const d = await detect(dir);
    expect(d.kind).toBe("python");
    expect(d.suggestedPort).toBe(8080);
    expect(d.profile).toBeNull();
  });
});

describe("commands", () => {
  it("runs persisted commands through a shell so $PORT can expand", () => {
    expect(shellInvocation("python3 -m http.server $PORT")).toEqual({
      cmd: "bash",
      args: ["-lc", "python3 -m http.server $PORT"],
    });
  });

  it("uses frozen installs when a lockfile exists", () => {
    expect(installCommand("npm", true)).toEqual({ cmd: "npm", args: ["ci"] });
    expect(installCommand("pnpm", true)).toEqual({
      cmd: "pnpm",
      args: ["install", "--frozen-lockfile"],
    });
    expect(installCommand("npm", false)).toEqual({ cmd: "npm", args: ["install"] });
    expect(installCommand("bun", true)).toEqual({
      cmd: "bun",
      args: ["install", "--frozen-lockfile"],
    });
  });
});

describe("framework port flags", () => {
  // Drift guard: these assert the flag is read from @vercel/frameworks' own dev
  // templates, so a renamed slug or changed flag fails here instead of silently
  // leaving a project's server bound to the wrong port.
  it("derives the exact port flag from each framework's dev template", () => {
    expect(portFlagForSlug("vite")).toBe("--port $PORT");
    expect(portFlagForSlug("nextjs")).toBe("--port $PORT");
    expect(portFlagForSlug("storybook")).toBe("-p $PORT");
    expect(portFlagForSlug("hugo")).toBe("-p $PORT");
  });

  it("returns no flag for frameworks that honor the PORT env var", () => {
    expect(portFlagForSlug("remix")).toBeUndefined();
    expect(portFlagForSlug("nuxtjs")).toBeUndefined();
    expect(portFlagForSlug(null)).toBeUndefined();
    expect(portFlagForSlug("not-a-framework")).toBeUndefined();
  });
});
