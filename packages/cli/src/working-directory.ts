import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type UnsafeWorkingDirectory = "home" | "filesystem-root";

async function canonicalPath(dir: string): Promise<string> {
  return realpath(dir).catch(() => path.resolve(dir));
}

/**
 * Avoid broad sync roots that would expose personal files or the whole host
 * when a user runs `up .` before changing into a project directory.
 */
export async function unsafeWorkingDirectory(dir: string): Promise<UnsafeWorkingDirectory | null> {
  const resolved = await canonicalPath(dir);
  if (resolved === (await canonicalPath(homedir()))) return "home";
  if (resolved === path.parse(resolved).root) return "filesystem-root";
  return null;
}
