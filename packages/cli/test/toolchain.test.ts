import { describe, expect, test } from "vitest";
import {
  installMarker,
  needsProvisioning,
  projectCommand,
  toolchainFingerprint,
} from "../src/toolchain.js";

describe("toolchain helpers", () => {
  test("only provisions remote managers that need a fixed tool", () => {
    expect(needsProvisioning({})).toBe(false);
    expect(needsProvisioning({ packageManager: "npm" })).toBe(false);
    expect(needsProvisioning({ packageManager: "npm", version: "10.9.0" })).toBe(true);
    expect(needsProvisioning({ packageManager: "pnpm", version: "10.23.0" })).toBe(true);
    expect(needsProvisioning({ packageManager: "bun", version: "1.3.14" })).toBe(true);
  });

  test("records toolchain identity in install markers", () => {
    expect(installMarker("pnpm install", { packageManager: "pnpm", version: "10.23.0" })).toBe(
      "pnpm install\ndev-pnpm@10.23.0",
    );
    expect(toolchainFingerprint({})).toBe("dev-toolchain:none");
  });

  test("runs project commands with remote tools and local binaries ahead of PATH", () => {
    expect(projectCommand("pnpm run dev", { packageManager: "pnpm", version: "10.23.0" })).toEqual({
      cmd: "bash",
      args: [
        "-lc",
        'export PATH="/vercel/sandbox/.dev-tools/bin:/vercel/sandbox/node_modules/.bin":"$PATH"; pnpm run dev',
      ],
    });
  });

  test("does not let stale remote tools shadow the base runtime when none are needed", () => {
    expect(projectCommand("npm run dev")).toEqual({
      cmd: "bash",
      args: ["-lc", 'export PATH="/vercel/sandbox/node_modules/.bin":"$PATH"; npm run dev'],
    });
  });
});
