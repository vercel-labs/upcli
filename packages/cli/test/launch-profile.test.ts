import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { rememberLaunchProfile } from "../src/config.js";
import type { LaunchProfile } from "../src/detect.js";
import { resolveLaunchProfile, writeSharedProfile } from "../src/launch-profile.js";

let dir: string;
let stateDir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "dev-profile-project-"));
  stateDir = await mkdtemp(path.join(os.tmpdir(), "dev-profile-state-"));
  process.env.DEV_STATE_DIR = stateDir;
});

afterEach(async () => {
  delete process.env.DEV_STATE_DIR;
  await rm(dir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

async function write(rel: string, content: string) {
  const file = path.join(dir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

const neverPrompt = vi.fn(async () => {
  throw new Error("unexpected prompt");
});

describe("resolveLaunchProfile", () => {
  test("uses automatic Node configuration when scripts.dev exists", async () => {
    await write("package.json", JSON.stringify({ scripts: { dev: "node server.js" } }));
    const result = await resolveLaunchProfile(dir, { prompt: neverPrompt });
    expect(result.source).toBe("detection");
    expect(result.profile.devCommand).toBe("npm run dev");
    expect(result.profile.port).toBe(3000);
  });

  test("applies flags above shared config above local config above detection", async () => {
    await write("package.json", JSON.stringify({ scripts: { dev: "next dev" } }));
    await rememberLaunchProfile(dir, {
      installCommand: "local install",
      devCommand: "local dev",
      port: 4100,
      dependencyFiles: ["local.lock"],
    });
    await writeSharedProfile(dir, {
      installCommand: "shared install",
      devCommand: "shared dev",
      port: 4200,
      dependencyFiles: ["shared.lock"],
    });

    const shared = await resolveLaunchProfile(dir, { prompt: neverPrompt });
    expect(shared.source).toBe("shared config");
    expect(shared.executesSharedCommands).toBe(true);
    expect(shared.profile).toEqual({
      installCommand: "shared install",
      devCommand: "shared dev",
      port: 4200,
      dependencyFiles: ["shared.lock"],
    });

    const flags = await resolveLaunchProfile(dir, {
      overrides: { command: "flag dev", installCommand: null, port: 4300 },
      prompt: neverPrompt,
    });
    expect(flags.source).toBe("flags");
    expect(flags.executesSharedCommands).toBe(false);
    expect(flags.profile).toEqual({
      installCommand: null,
      devCommand: "flag dev",
      port: 4300,
      dependencyFiles: ["shared.lock"],
    });
  });

  test("requires trust when shared config supplies only an install command", async () => {
    await write("package.json", JSON.stringify({ scripts: { dev: "node server.js" } }));
    await write("up.config.json", JSON.stringify({ installCommand: "node suspicious.js" }));

    const result = await resolveLaunchProfile(dir, { prompt: neverPrompt });

    expect(result.profile.devCommand).toBe("npm run dev");
    expect(result.executesSharedCommands).toBe(true);
  });

  test("reads legacy dev.config.json when up.config.json is absent", async () => {
    await write("package.json", JSON.stringify({ scripts: { dev: "node server.js" } }));
    await write("dev.config.json", JSON.stringify({ devCommand: "legacy dev", port: 4400 }));

    const result = await resolveLaunchProfile(dir, { prompt: neverPrompt });

    expect(result.source).toBe("shared config");
    expect(result.profile.devCommand).toBe("legacy dev");
    expect(result.profile.port).toBe(4400);
  });

  test("prefers up.config.json over legacy dev.config.json", async () => {
    await write("package.json", JSON.stringify({ scripts: { dev: "node server.js" } }));
    await write("dev.config.json", JSON.stringify({ devCommand: "legacy dev", port: 4400 }));
    await write("up.config.json", JSON.stringify({ devCommand: "shared up", port: 4500 }));

    const result = await resolveLaunchProfile(dir, { prompt: neverPrompt });

    expect(result.source).toBe("shared config");
    expect(result.profile.devCommand).toBe("shared up");
    expect(result.profile.port).toBe(4500);
  });

  test("prompts once for ambiguous Python and remembers the result locally", async () => {
    await write("requirements.txt", "fastapi\n");
    const selected: LaunchProfile = {
      installCommand: "python3 -m pip install -r requirements.txt",
      devCommand: "python3 -m uvicorn app:app --port $PORT",
      port: 8080,
      dependencyFiles: ["requirements.txt"],
    };
    const prompt = vi.fn(async () => selected);
    const first = await resolveLaunchProfile(dir, { prompt });
    expect(first.source).toBe("interactive");
    expect(first.profile).toEqual(selected);

    const second = await resolveLaunchProfile(dir, { prompt: neverPrompt });
    expect(second.source).toBe("local config");
    expect(second.profile).toEqual(selected);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  test("writes a shareable up.config.json when requested", async () => {
    await write("index.html", "<main>hello</main>");
    const result = await resolveLaunchProfile(dir, { saveConfig: true, prompt: neverPrompt });
    const raw = JSON.parse(await readFile(path.join(dir, "up.config.json"), "utf8"));
    expect(raw).toEqual(result.profile);
    expect(result.profile.port).toBe(8080);
  });

  test("rejects a blank install command in shared configuration", async () => {
    await write("package.json", JSON.stringify({ scripts: { dev: "node server.js" } }));
    await write("up.config.json", JSON.stringify({ installCommand: " " }));
    await expect(resolveLaunchProfile(dir, { prompt: neverPrompt })).rejects.toThrow(
      "installCommand must be a non-empty string or null",
    );
  });

  test("rejects unsafe dependency glob patterns in shared configuration", async () => {
    await write("package.json", JSON.stringify({ scripts: { dev: "node server.js" } }));
    await write("up.config.json", JSON.stringify({ dependencyFiles: ["../secrets"] }));

    await expect(resolveLaunchProfile(dir, { prompt: neverPrompt })).rejects.toThrow(
      "unsafe dependency file pattern",
    );
  });
});
