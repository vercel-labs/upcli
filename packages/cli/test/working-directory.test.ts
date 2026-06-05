import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { unsafeWorkingDirectory } from "../src/working-directory.js";

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

test("refuses the user's home directory as a sync root", async () => {
  await expect(unsafeWorkingDirectory(homedir())).resolves.toBe("home");
});

test("refuses the filesystem root as a sync root", async () => {
  await expect(unsafeWorkingDirectory(path.parse(homedir()).root)).resolves.toBe("filesystem-root");
});

test("permits a normal project directory", async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "dev-project-"));
  await expect(unsafeWorkingDirectory(scratch)).resolves.toBeNull();
});
