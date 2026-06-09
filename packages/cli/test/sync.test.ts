import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DevSandbox } from "../src/sandbox.js";
import {
  changedSince,
  collectFiles,
  createMandatoryIgnore,
  deletedSince,
  manifestAfterScan,
  manifestOf,
  reconcileFiles,
  removeFiles,
  uploadFiles,
} from "../src/sync.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dev-sync-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, content = "x") {
  const abs = path.join(dir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe("collectFiles", () => {
  it("includes source and skips node_modules/.git/build/internal tools", async () => {
    await write("src/index.ts");
    await write("package.json");
    await write("node_modules/left-pad/index.js");
    await write(".git/config");
    await write("dist/out.js");
    await write(".dev-tools/bun/bin/bun");
    const { files } = await collectFiles(dir);
    const rels = files.map((f) => f.rel).sort();
    expect(rels).toEqual(["package.json", "src/index.ts"]);
  });

  it("skips .env by default and reports it", async () => {
    await write("index.js");
    await write(".env", "SECRET=1");
    await write(".env.local", "SECRET=2");
    await write(".envrc", "SECRET=3");
    const { files, skippedEnv } = await collectFiles(dir);
    expect(files.map((f) => f.rel)).toEqual(["index.js"]);
    expect(skippedEnv).toBe(true);
  });

  it("skips sensitive config by default and allows explicit opt-in without key material", async () => {
    await write("index.js");
    await write(".npmrc", "//registry.npmjs.org/:_authToken=secret");
    await write("nested/.yarnrc.yml", "npmAuthToken: secret");
    await write(".netrc", "machine example.com login secret");
    await write(".pypirc", "[pypi]");
    await write(".direnv/layout", "layout node");
    await write(".ssh/id_rsa", "private key");
    await write(".aws/credentials", "secret");
    await write(".gnupg/private.key", "secret");
    await write("cert.pem", "secret");
    await write("private.key", "secret");
    await write("id_ed25519", "secret");

    const defaultScan = await collectFiles(dir);
    expect(defaultScan.files.map((f) => f.rel).sort()).toEqual(["index.js"]);
    expect(defaultScan.skippedSensitiveConfig).toEqual([
      ".direnv",
      ".netrc",
      ".npmrc",
      ".pypirc",
      "nested/.yarnrc.yml",
    ]);
    expect(defaultScan.skippedSensitiveKeys).toEqual([
      ".aws",
      ".gnupg",
      ".ssh",
      "cert.pem",
      "id_ed25519",
      "private.key",
    ]);

    const optedIn = await collectFiles(dir, { includeSensitiveConfig: true });
    expect(optedIn.files.map((f) => f.rel).sort()).toEqual([
      ".direnv/layout",
      ".netrc",
      ".npmrc",
      ".pypirc",
      "index.js",
      "nested/.yarnrc.yml",
    ]);
    expect(optedIn.skippedSensitiveConfig).toEqual([]);
    expect(optedIn.skippedSensitiveKeys).toEqual([
      ".aws",
      ".gnupg",
      ".ssh",
      "cert.pem",
      "id_ed25519",
      "private.key",
    ]);
  });

  it("does not let .gitignore re-include sensitive config or key material by default", async () => {
    await write(".gitignore", "!.npmrc\n!.ssh/id_rsa\n");
    await write(".npmrc", "token");
    await write(".ssh/id_rsa", "private key");
    await write("index.js");

    const { files, skippedSensitiveConfig, skippedSensitiveKeys } = await collectFiles(dir);
    expect(files.map((f) => f.rel).sort()).toEqual([".gitignore", "index.js"]);
    expect(skippedSensitiveConfig).toEqual([".npmrc"]);
    expect(skippedSensitiveKeys).toEqual([".ssh"]);
  });

  it("allows opted-in sensitive config even when a gitignore negates it", async () => {
    await write(".gitignore", "!.npmrc\n");
    await write(".npmrc", "token");
    await write("index.js");
    const { files } = await collectFiles(dir, { includeSensitiveConfig: true });
    expect(files.map((f) => f.rel).sort()).toEqual([".gitignore", ".npmrc", "index.js"]);
  });

  it("uploads opted-in sensitive config even when gitignore excludes it", async () => {
    await write(".gitignore", ".npmrc\n");
    await write(".npmrc", "token");
    await write("index.js");
    const { files } = await collectFiles(dir, { includeSensitiveConfig: true });
    expect(files.map((f) => f.rel).sort()).toEqual([".gitignore", ".npmrc", "index.js"]);
  });

  it("keeps obvious key material mandatory ignored even with opt-in", () => {
    const defaultIgnores = createMandatoryIgnore();
    const optedInIgnores = createMandatoryIgnore({ includeSensitiveConfig: true });
    expect(defaultIgnores.ignores(".npmrc")).toBe(true);
    expect(optedInIgnores.ignores(".npmrc")).toBe(false);
    expect(defaultIgnores.ignores(".ssh/")).toBe(true);
    expect(optedInIgnores.ignores(".ssh/")).toBe(true);
    expect(optedInIgnores.ignores("nested/id_rsa")).toBe(true);
  });

  it("honors .gitignore", async () => {
    await write(".gitignore", "ignored.txt\n");
    await write("kept.txt");
    await write("ignored.txt");
    const { files } = await collectFiles(dir);
    expect(files.map((f) => f.rel).sort()).toEqual([".gitignore", "kept.txt"]);
  });

  it("honors nested .gitignore files before uploading subtree contents", async () => {
    await write("apps/api/.gitignore", "credentials.json\n");
    await write("apps/api/credentials.json", '{"token":"private"}');
    await write("apps/api/index.ts");
    const { files } = await collectFiles(dir);
    expect(files.map((f) => f.rel).sort()).toEqual(["apps/api/.gitignore", "apps/api/index.ts"]);
  });

  it("supports nested .gitignore negation when its parent directory is traversable", async () => {
    await write(".gitignore", "*.txt\n");
    await write("apps/site/.gitignore", "!public.txt\n");
    await write("apps/site/public.txt");
    const { files } = await collectFiles(dir);
    expect(files.map((f) => f.rel).sort()).toEqual([
      ".gitignore",
      "apps/site/.gitignore",
      "apps/site/public.txt",
    ]);
  });

  it("does not let .gitignore re-include secrets or mandatory ignored paths", async () => {
    await write(
      ".gitignore",
      "!.env\n!.envrc\n!node_modules/left-pad/index.js\n!dist/out.js\n!.dev-install-command\n",
    );
    await write(".env", "SECRET=1");
    await write(".envrc", "SECRET=2");
    await write("node_modules/left-pad/index.js");
    await write("dist/out.js");
    await write(".dev-install-command", "malicious install");
    await write("index.js");
    const { files, skippedEnv } = await collectFiles(dir);
    expect(files.map((f) => f.rel).sort()).toEqual([".gitignore", "index.js"]);
    expect(skippedEnv).toBe(true);
  });

  it("does not let nested .gitignore re-include mandatory excluded paths", async () => {
    await write("apps/api/.gitignore", "!.env\n!node_modules/private/index.js\n");
    await write("apps/api/.env", "TOKEN=private");
    await write("apps/api/node_modules/private/index.js");
    await write("apps/api/index.js");
    const { files, skippedEnv } = await collectFiles(dir);
    expect(files.map((f) => f.rel).sort()).toEqual(["apps/api/.gitignore", "apps/api/index.js"]);
    expect(skippedEnv).toBe(true);
  });

  it("keeps an explicitly selected env file local even when its name is otherwise syncable", async () => {
    await write(".gitignore", "!secrets.env\n!config/prod.env\n");
    await write("index.js");
    await write("secrets.env", "TOKEN=secret");
    await write("config/prod.env", "TOKEN=secret");
    await write("!local.env", "TOKEN=secret");

    const { files } = await collectFiles(dir, {
      extraIgnoredPaths: ["secrets.env", "config/prod.env", "!local.env"],
    });

    expect(files.map((f) => f.rel).sort()).toEqual([".gitignore", "index.js"]);
  });

  it("skips and reports unreadable nested directories", async () => {
    await write("index.js");
    await write("restricted/secret.txt");
    const restricted = path.join(dir, "restricted");
    await chmod(restricted, 0o000);
    try {
      const { files, skippedUnreadable } = await collectFiles(dir);
      expect(files.map((f) => f.rel)).toEqual(["index.js"]);
      expect(skippedUnreadable).toEqual(["restricted"]);
    } finally {
      await chmod(restricted, 0o700);
    }
  });

  it("skips a nested subtree when its .gitignore cannot be read", async () => {
    await write("index.js");
    await write("private/.gitignore", "secret.json\n");
    await write("private/secret.json");
    const gitignore = path.join(dir, "private/.gitignore");
    await chmod(gitignore, 0o000);
    try {
      const { files, skippedUnreadable } = await collectFiles(dir);
      expect(files.map((f) => f.rel)).toEqual(["index.js"]);
      expect(skippedUnreadable).toEqual(["private"]);
    } finally {
      await chmod(gitignore, 0o600);
    }
  });

  it("reports files that exceed the per-file sync limit", async () => {
    await write("small.txt", "ok");
    await write("large.bin", "abcd");
    const { files, skippedLarge } = await collectFiles(dir, { maxFileBytes: 3 });
    expect(files.map((f) => f.rel)).toEqual(["small.txt"]);
    expect(skippedLarge).toEqual(["large.bin"]);
  });

  it("skips symlinks instead of following them", async () => {
    if (process.platform === "win32") return;
    await write("target.txt", "safe");
    await symlink("target.txt", path.join(dir, "link.txt"));
    const { files, skippedSymlinks } = await collectFiles(dir);
    expect(files.map((f) => f.rel)).toEqual(["target.txt"]);
    expect(skippedSymlinks).toEqual(["link.txt"]);
  });

  it("skips symlinked directories instead of traversing outside the project", async () => {
    if (process.platform === "win32") return;
    await write("index.js");
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "private");
    await symlink(outside, path.join(dir, "linked"));

    try {
      const { files, skippedSymlinks } = await collectFiles(dir);
      expect(files.map((f) => f.rel)).toEqual(["index.js"]);
      expect(skippedSymlinks).toEqual(["linked"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("manifest diffing", () => {
  it("detects changed and deleted files", async () => {
    await write("a.txt", "one");
    await write("b.txt", "two");
    const first = await collectFiles(dir);
    const prev = manifestOf(first.files);

    // Modify a, delete b.
    await write("a.txt", "one-longer");
    await rm(path.join(dir, "b.txt"));
    const second = await collectFiles(dir);

    const changed = changedSince(prev, second.files).map((f) => f.rel);
    const deleted = deletedSince(prev, second.files);
    expect(changed).toContain("a.txt");
    expect(deleted).toEqual(["b.txt"]);
  });

  it("detects executable-bit changes without hashing the tree", async () => {
    if (process.platform === "win32") return;
    await write("script.sh", "#!/bin/sh\n");
    await chmod(path.join(dir, "script.sh"), 0o755);
    const first = await collectFiles(dir);
    const prev = manifestOf(first.files);

    await chmod(path.join(dir, "script.sh"), 0o644);
    const second = await collectFiles(dir);
    expect(changedSince(prev, second.files).map((f) => f.rel)).toEqual(["script.sh"]);
  });

  it("tracks files with prototype-like names in the manifest", async () => {
    await write("__proto__", "one");
    const first = await collectFiles(dir);
    const prev = manifestOf(first.files);

    expect(Object.hasOwn(prev, "__proto__")).toBe(true);
    expect(changedSince(prev, first.files)).toEqual([]);

    await write("__proto__", "two");
    const second = await collectFiles(dir);
    expect(changedSince(prev, second.files).map((f) => f.rel)).toEqual(["__proto__"]);
  });

  it("treats an empty manifest as a full resync with no deletions", async () => {
    // This is the guarantee the CLI leans on when a sandbox is recreated from
    // scratch: it discards the stale manifest (prev = {}) so everything uploads.
    await write("a.txt");
    await write("nested/b.txt");
    const { files } = await collectFiles(dir);

    const changed = changedSince({}, files)
      .map((f) => f.rel)
      .sort();
    const deleted = deletedSince({}, files);
    expect(changed).toEqual(["a.txt", "nested/b.txt"]);
    expect(deleted).toEqual([]);
  });

  it("does not delete previously synced files under an unreadable path", () => {
    const prev = {
      "restricted/secret.txt": { size: 1, mtimeMs: 1 },
      "removed.txt": { size: 1, mtimeMs: 1 },
    };

    expect(deletedSince(prev, [], ["restricted"])).toEqual(["removed.txt"]);
  });

  it("retains manifest entries under an unreadable path until it can be scanned", () => {
    const prev = {
      "restricted/secret.txt": { size: 1, mtimeMs: 1 },
      "removed.txt": { size: 1, mtimeMs: 1 },
    };

    expect(manifestAfterScan(prev, [], ["restricted"])).toEqual({
      "restricted/secret.txt": { size: 1, mtimeMs: 1 },
    });
  });

  it("reconciles an edit made after the initial boot sync", async () => {
    await write("app.txt", "initial");
    const first = await collectFiles(dir);
    const uploads: Array<{ path: string; content: string }> = [];
    const sandbox = {
      writeFiles: async (files: Array<{ path: string; content: Uint8Array }>) => {
        uploads.push(
          ...files.map((file) => ({
            path: file.path,
            content: Buffer.from(file.content).toString("utf8"),
          })),
        );
      },
      exec: async () => ({ exitCode: 0 }),
    } as unknown as DevSandbox;

    await write("app.txt", "edited while starting");
    const result = await reconcileFiles(sandbox, dir, manifestOf(first.files));

    expect(result.uploaded).toBe(1);
    expect(result.changedPaths).toEqual(["app.txt"]);
    expect(uploads).toEqual([{ path: "app.txt", content: "edited while starting" }]);
  });

  it("refuses a file replaced with a symlink between collection and upload", async () => {
    if (process.platform === "win32") return;
    await write("target.txt", "safe");
    const { files } = await collectFiles(dir);
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-secret.txt`);
    await writeFile(outside, "private");
    await rm(path.join(dir, "target.txt"));
    await symlink(outside, path.join(dir, "target.txt"));
    const sandbox = {
      writeFiles: async () => {},
    } as unknown as DevSandbox;

    try {
      await expect(uploadFiles(sandbox, files)).rejects.toThrow();
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("refuses a parent directory replaced with a symlink between collection and upload", async () => {
    if (process.platform === "win32") return;
    await write("safe/target.txt", "safe");
    const { files } = await collectFiles(dir);
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside`);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "target.txt"), "private");
    await rm(path.join(dir, "safe"), { recursive: true, force: true });
    await symlink(outside, path.join(dir, "safe"));
    const sandbox = {
      writeFiles: async () => {},
    } as unknown as DevSandbox;

    try {
      await expect(uploadFiles(sandbox, files)).rejects.toThrow(
        "Refusing to read substituted file",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects traversal paths loaded from a cached manifest before remote deletion", async () => {
    const commands: string[][] = [];
    const sandbox = {
      writeFiles: async () => {},
      exec: async (_cmd: string, args: string[]) => {
        commands.push(args);
        return { exitCode: 0 };
      },
    } as unknown as DevSandbox;

    await expect(
      reconcileFiles(sandbox, dir, { "../tmp/dev-supervisor.cjs": { size: 1, mtimeMs: 1 } }),
    ).rejects.toThrow("Unsafe sync path in local state");
    expect(commands).toEqual([]);
  });

  it("constructs remote deletions only below the sandbox project root", async () => {
    const commands: string[][] = [];
    const sandbox = {
      exec: async (_cmd: string, args: string[]) => {
        commands.push(args);
        return { exitCode: 0 };
      },
    } as unknown as DevSandbox;

    await removeFiles(sandbox, ["src/removed.ts"]);

    expect(commands).toEqual([["-f", "--", "/vercel/sandbox/src/removed.ts"]]);
  });
});
