import { describe, expect, test } from "vitest";
import type { DevSandbox } from "../src/sandbox.js";
import { installEtaFromDeps, startEtaFor, writeStatus } from "../src/status.js";

describe("installEtaFromDeps", () => {
  test("scales the install ETA by dependency count, at the bucket boundaries", () => {
    expect(installEtaFromDeps(0)).toBe(15_000);
    expect(installEtaFromDeps(24)).toBe(15_000);
    expect(installEtaFromDeps(25)).toBe(30_000);
    expect(installEtaFromDeps(74)).toBe(30_000);
    expect(installEtaFromDeps(75)).toBe(50_000);
    expect(installEtaFromDeps(149)).toBe(50_000);
    expect(installEtaFromDeps(150)).toBe(75_000);
    expect(installEtaFromDeps(500)).toBe(75_000);
  });
});

describe("startEtaFor", () => {
  test("uses per-framework boot times with a sane default", () => {
    expect(startEtaFor("nextjs")).toBe(9_000);
    expect(startEtaFor("nuxtjs")).toBe(9_000);
    expect(startEtaFor("astro")).toBe(6_000);
    expect(startEtaFor("vite")).toBe(4_000);
    expect(startEtaFor("sveltekit")).toBe(4_000);
    expect(startEtaFor("rocket-science")).toBe(8_000);
    expect(startEtaFor(null)).toBe(8_000);
    expect(startEtaFor(undefined)).toBe(8_000);
  });
});

describe("writeStatus", () => {
  test("writes the snapshot as JSON to the status file path", async () => {
    const writes: { path: string; content: string }[] = [];
    const sandbox = {
      writeFiles: async (files: { path: string; content: string }[]) => {
        for (const f of files) writes.push(f);
      },
    } as unknown as DevSandbox;

    await writeStatus(sandbox, {
      label: "installing dependencies",
      base: 25,
      ceiling: 90,
      etaMs: 30_000,
    });

    expect(writes).toHaveLength(1);
    const write = writes[0];
    if (!write) throw new Error("expected exactly one write");
    expect(write.path).toBe("/tmp/dev-status.json");
    expect(JSON.parse(write.content)).toEqual({
      label: "installing dependencies",
      base: 25,
      ceiling: 90,
      etaMs: 30_000,
    });
  });

  test("never throws if the sandbox write fails (it is best-effort)", async () => {
    const sandbox = {
      writeFiles: async () => {
        throw new Error("network down");
      },
    } as unknown as DevSandbox;

    await expect(
      writeStatus(sandbox, { label: "syncing files", base: 10, ceiling: 25, etaMs: 3000 }),
    ).resolves.toBeUndefined();
  });

  test("propagates a required final-status write failure", async () => {
    const sandbox = {
      writeFiles: async () => {
        throw new Error("network down");
      },
    } as unknown as DevSandbox;

    await expect(
      writeStatus(
        sandbox,
        { label: "ready", base: 100, ceiling: 100, etaMs: 0, ready: true },
        { required: true },
      ),
    ).rejects.toThrow("network down");
  });
});
