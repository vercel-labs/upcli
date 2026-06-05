import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get as httpGet, type IncomingHttpHeaders, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

// Run the supervisor source straight from disk (it is what gets bundled) as a
// standalone CommonJS script, with a fake "dev server" target we control.
const supervisorSrc = readFileSync(
  fileURLToPath(new URL("../src/supervisor.runtime.txt", import.meta.url)),
  "utf8",
);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function get(
  port: number,
  p = "/",
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = httpGet({ host: "127.0.0.1", port, path: p }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.once("error", reject);
  });
}

/** Open an SSE stream and accumulate parsed `data:` frames into `frames`. */
function openSSE(port: number): { frames: Record<string, unknown>[]; close: () => void } {
  const frames: Record<string, unknown>[] = [];
  const req = httpGet({ host: "127.0.0.1", port, path: "/__dev/events" }, (res) => {
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      let i = buf.indexOf("\n\n");
      while (i >= 0) {
        const line = buf
          .slice(0, i)
          .split("\n")
          .find((l) => l.startsWith("data:"));
        buf = buf.slice(i + 2);
        if (line) {
          try {
            frames.push(JSON.parse(line.slice(5).trim()));
          } catch {
            // ignore non-JSON frames (e.g. the retry directive)
          }
        }
        i = buf.indexOf("\n\n");
      }
    });
  });
  req.once("error", () => {});
  return { frames, close: () => req.destroy() };
}

async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  timeoutMs = 8000,
  stepMs = 100,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

let publicPort: number;
let targetPort: number;
let statusFile: string;
let tmp: string;
let supervisor: ChildProcess;
let target: Server | undefined;
let supErr = "";

beforeAll(async () => {
  publicPort = await freePort();
  targetPort = await freePort();
  tmp = mkdtempSync(path.join(os.tmpdir(), "dev-sup-"));
  statusFile = path.join(tmp, "status.json");
  const scriptPath = path.join(tmp, "supervisor.cjs");
  writeFileSync(scriptPath, supervisorSrc);

  supervisor = spawn(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      DEV_PUBLIC_PORT: String(publicPort),
      DEV_TARGET_PORT: String(targetPort),
      DEV_STATUS_FILE: statusFile,
      DEV_RUN_ID: "test-run-id",
      DEV_MAX_STATUS_CLIENTS: "2",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  supervisor.stderr?.on("data", (d) => {
    supErr += String(d);
  });

  try {
    await waitFor(async () => (await get(publicPort, "/__dev/status")).status === 200);
  } catch {
    throw new Error(`supervisor did not start. stderr:\n${supErr}`);
  }
}, 15000);

afterAll(() => {
  supervisor?.kill();
  target?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("serves the boot page until the dev server is up", async () => {
  const res = await get(publicPort, "/");
  expect(res.status).toBe(200);
  expect(res.body).toContain("starting your up environment");
  expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(res.headers["referrer-policy"]).toBe("no-referrer");
});

test("/__dev/status reflects the CLI snapshot and is not ready yet", async () => {
  writeFileSync(
    statusFile,
    JSON.stringify({ label: "installing dependencies", base: 25, ceiling: 90, etaMs: 30000 }),
  );
  const res = await get(publicPort, "/__dev/status");
  const data = JSON.parse(res.body);
  expect(data.label).toBe("installing dependencies");
  expect(data.base).toBe(25);
  expect(data.ready).toBe(false);
  // The supervisor echoes the boot's run id so the CLI healthcheck can confirm
  // it is talking to the supervisor it just launched.
  expect(data.runId).toBe("test-run-id");
});

test("/__dev/events pushes an initial status frame", async () => {
  writeFileSync(
    statusFile,
    JSON.stringify({ label: "syncing files", base: 10, ceiling: 25, etaMs: 3000 }),
  );
  const sse = openSSE(publicPort);
  const frame = await waitFor(async () => sse.frames.find((f) => f.label === "syncing files"));
  expect(frame.ceiling).toBe(25);
  expect(frame.ready).toBe(false);
  sse.close();
});

test("/__dev/events bounds concurrent boot status streams", async () => {
  const first = openSSE(publicPort);
  const second = openSSE(publicPort);
  await waitFor(async () => first.frames[0] && second.frames[0]);

  const rejected = await get(publicPort, "/__dev/events");
  expect(rejected.status).toBe(503);
  expect(rejected.body).toContain("too many status streams");

  first.close();
  second.close();
});

test("keeps boot page until the CLI releases a reachable target", async () => {
  const sse = openSSE(publicPort);

  target = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello from target");
  });
  await new Promise<void>((resolve) => target?.listen(targetPort, "127.0.0.1", resolve));
  await new Promise((resolve) => setTimeout(resolve, 500));

  const stillBooting = await get(publicPort, "/");
  expect(stillBooting.body).toContain("starting your up environment");

  writeFileSync(
    statusFile,
    JSON.stringify({ label: "ready", base: 100, ceiling: 100, etaMs: 0, ready: true }),
  );
  const readyFrame = await waitFor(async () => sse.frames.find((f) => f.ready === true));
  expect(readyFrame.ready).toBe(true);

  // And subsequent requests are proxied through to the target.
  const proxied = await waitFor(async () => {
    const r = await get(publicPort, "/");
    return r.body.includes("hello from target") ? r : undefined;
  });
  expect(proxied.status).toBe(200);

  sse.close();
}, 15000);
