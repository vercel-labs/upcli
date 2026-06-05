import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type WatchHandle, watchProject } from "../src/watch.js";

let dir: string;
let watcher: WatchHandle | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dev-watch-"));
});

afterEach(async () => {
  await watcher?.close();
  watcher = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, content: string) {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

test("observes changes to a file re-included by a nested gitignore", async () => {
  await write(".gitignore", "*.txt\n");
  await write("apps/site/.gitignore", "!visible.txt\n");
  await write("apps/site/visible.txt", "one");

  let changed!: (source: "event" | "poll") => void;
  const notification = new Promise<"event" | "poll">((resolve) => {
    changed = resolve;
  });
  watcher = await watchProject(dir, { debounceMs: 5, onChange: changed });

  await write("apps/site/visible.txt", "two");

  await expect(withTimeout(notification, 3000)).resolves.toBe("event");
});

test("falls back to polling instead of crashing when native watching hits EMFILE", async () => {
  let changed!: (source: "event" | "poll") => void;
  let fallback: Error | undefined;
  const notification = new Promise<"event" | "poll">((resolve) => {
    changed = resolve;
  });
  watcher = await watchProject(dir, {
    debounceMs: 1,
    pollIntervalMs: 5,
    onChange: changed,
    onFallback: (err) => {
      fallback = err;
    },
    createWatcher: () => {
      const err = Object.assign(new Error("too many open files, watch"), { code: "EMFILE" });
      throw err;
    },
  });

  await expect(withTimeout(notification, 3000)).resolves.toBe("poll");
  expect(fallback).toMatchObject({ message: "too many open files, watch" });
});

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("watch event timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
