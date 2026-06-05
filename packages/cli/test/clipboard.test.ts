import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

import { copyToClipboard } from "../src/ui.js";

function childResult(code: number, inputs: string[]) {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough };
  child.stdin = new PassThrough();
  child.stdin.on("data", (chunk) => inputs.push(String(chunk)));
  queueMicrotask(() => child.emit("close", code));
  return child;
}

afterEach(() => {
  vi.restoreAllMocks();
  mockSpawn.mockReset();
});

describe("copyToClipboard", () => {
  test("writes through pbcopy on macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const inputs: string[] = [];
    mockSpawn.mockImplementation(() => childResult(0, inputs));

    expect(await copyToClipboard("https://sb-example.vercel.run")).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith("pbcopy", [], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    expect(inputs.join("")).toBe("https://sb-example.vercel.run");
  });

  test("falls back between available Linux clipboard commands", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    mockSpawn
      .mockImplementationOnce(() => childResult(1, []))
      .mockImplementationOnce(() => childResult(0, []));

    expect(await copyToClipboard("url")).toBe(true);
    expect(mockSpawn).toHaveBeenNthCalledWith(1, "wl-copy", [], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    expect(mockSpawn).toHaveBeenNthCalledWith(2, "xsel", ["--clipboard", "--input"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
  });
});
