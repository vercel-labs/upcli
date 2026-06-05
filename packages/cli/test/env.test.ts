import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findDefaultEnvFile, parseDotenv, readEnvFile } from "../src/env.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dev-env-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseDotenv", () => {
  test("parses comments, exports, quotes and escapes", () => {
    expect(
      parseDotenv(
        [
          "# comment",
          "export NAME=value",
          'QUOTED="hello\\nworld" # trailing comment',
          "SINGLE='literal value'",
          "EMPTY=",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      NAME: "value",
      QUOTED: "hello\nworld",
      SINGLE: "literal value",
      EMPTY: "",
    });
  });

  test("keeps prototype-like env keys as ordinary values", () => {
    const values = parseDotenv("__proto__=safe\nconstructor=value\n");
    expect(Object.getPrototypeOf(values)).toBeNull();
    expect(Object.hasOwn(values, "__proto__")).toBe(true);
    expect(values.__proto__).toBe("safe");
    expect(values.constructor).toBe("value");
  });

  test("handles an even number of backslashes before a closing quote", () => {
    expect(parseDotenv('PATH="C:\\\\tools\\\\"')).toEqual({
      PATH: "C:\\tools\\",
    });
  });

  test("parses a multiline double-quoted value (e.g. a PEM key)", () => {
    expect(
      parseDotenv(
        [
          'PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----',
          "MIIEowIBAAKCAQEA1234",
          "abcdefgh",
          '-----END RSA PRIVATE KEY-----"',
          "OTHER=value",
        ].join("\n"),
      ),
    ).toEqual({
      PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcdefgh\n-----END RSA PRIVATE KEY-----",
      OTHER: "value",
    });
  });

  test("parses a multiline value with an escaped quote inside", () => {
    expect(parseDotenv('MSG="line one\nstill \\"quoted\\" here\nline three"')).toEqual({
      MSG: 'line one\nstill "quoted" here\nline three',
    });
  });

  test("rejects malformed assignments", () => {
    expect(() => parseDotenv("NOT A VALUE")).toThrow("Invalid env assignment");
    expect(() => parseDotenv("BAD-KEY=value")).toThrow("Invalid env key");
    expect(() => parseDotenv('QUOTE="unterminated')).toThrow("Unterminated quoted value");
    expect(() => parseDotenv('QUOTE="line one\nline two\nno close')).toThrow(
      "Unterminated quoted value",
    );
  });
});

describe("readEnvFile", () => {
  test("reads a regular file inside the project", async () => {
    await writeFile(path.join(dir, ".env.local"), "TOKEN=secret\n");
    await expect(readEnvFile(dir, ".env.local")).resolves.toEqual({
      rel: ".env.local",
      values: { TOKEN: "secret" },
    });
  });

  test("rejects paths outside the project", async () => {
    await expect(readEnvFile(dir, "../.env")).rejects.toThrow("Unsafe env file path");
  });

  test("refuses symlinks", async () => {
    if (process.platform === "win32") return;
    await writeFile(path.join(dir, "target.env"), "TOKEN=secret\n");
    await symlink("target.env", path.join(dir, ".env.local"));
    await expect(readEnvFile(dir, ".env.local")).rejects.toThrow();
  });

  test("refuses a symlinked parent that escapes the project", async () => {
    if (process.platform === "win32") return;
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, ".env.local"), "TOKEN=secret\n");
    await symlink(outside, path.join(dir, "linked"));

    try {
      await expect(readEnvFile(dir, "linked/.env.local")).rejects.toThrow(
        "Env file must stay inside the project",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("findDefaultEnvFile", () => {
  test("finds a regular .env.local file", async () => {
    await writeFile(path.join(dir, ".env.local"), "TOKEN=secret\n");
    await expect(findDefaultEnvFile(dir)).resolves.toBe(".env.local");
  });

  test("does not follow a .env.local symlink", async () => {
    if (process.platform === "win32") return;
    await writeFile(path.join(dir, "target.env"), "TOKEN=secret\n");
    await symlink("target.env", path.join(dir, ".env.local"));
    await expect(findDefaultEnvFile(dir)).resolves.toBeUndefined();
  });
});
