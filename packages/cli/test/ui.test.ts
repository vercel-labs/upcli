import { stripVTControlCharacters } from "node:util";
import { describe, expect, test, vi } from "vitest";
import {
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  sanitizeTerminalText,
  TerminalFlow,
} from "../src/ui.js";

function outputCapture() {
  let text = "";
  return {
    output: {
      write(chunk: string) {
        text += chunk;
      },
    },
    read: () => text,
  };
}

function gatedDelay() {
  const releases: Array<() => void> = [];
  return {
    delay: async () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      }),
    pending: () => releases.length,
    release: () => releases.shift()?.(),
  };
}

async function settlePromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Terminal spinner", () => {
  test("uses a compact circular indicator", () => {
    expect(SPINNER_FRAMES).toEqual(["◒", "◐", "◓", "◑"]);
    expect(SPINNER_INTERVAL_MS).toBe(80);
  });

  test("prints only settled states for non-interactive output", async () => {
    const capture = outputCapture();
    const ui = new TerminalFlow({ output: capture.output, animated: false });
    const spinner = ui.spinner();

    spinner.start("Authenticating");
    spinner.message("Still working");
    await spinner.stop("Authenticated");

    expect(capture.read()).toContain("●  Authenticated");
    expect(capture.read()).not.toContain("Authenticating");
    expect(capture.read()).not.toContain("Still working");
    expect(capture.read()).not.toContain(SPINNER_FRAMES[0]);
  });

  test("does not leave an old interval behind when the same spinner starts twice", async () => {
    vi.useFakeTimers();
    try {
      const capture = outputCapture();
      const ui = new TerminalFlow({
        output: capture.output,
        animated: true,
        characterIntervalMs: 0,
      });
      const spinner = ui.spinner();

      spinner.start("Starting");
      spinner.start("Restarting");
      vi.advanceTimersByTime(SPINNER_INTERVAL_MS * 2);
      await spinner.stop("Ready");
      const stopped = capture.read();

      vi.advanceTimersByTime(SPINNER_INTERVAL_MS * 2);
      expect(capture.read()).toBe(stopped);
    } finally {
      vi.useRealTimers();
    }
  });

  test("strips styles from messages written to non-interactive output", async () => {
    const capture = outputCapture();
    const ui = new TerminalFlow({ output: capture.output, animated: false });

    await ui.step("\u001B[1mReady\u001B[22m");

    expect(capture.read()).toBe("●  Ready\n│\n");
  });
});

describe("sanitizeTerminalText", () => {
  test("removes escape sequences and makes line controls visible", () => {
    expect(sanitizeTerminalText("bad\u001B]8;;https://fake.example\u0007name\nnext\rrow")).toBe(
      "badname\\x0anext\\x0drow",
    );
  });

  test("can preserve log newlines while blocking carriage-return rewriting", () => {
    expect(sanitizeTerminalText("first\nsecond\roverwrite", { preserveNewlines: true })).toBe(
      "first\nsecond\\x0doverwrite",
    );
  });
});

describe("TerminalFlow", () => {
  test("adds explicit hyperlinks only for terminal output", () => {
    const url = "https://sb-example.vercel.run";
    const interactive = new TerminalFlow({ animated: true });
    const logged = new TerminalFlow({ animated: false });

    expect(interactive.link(url)).toContain(`\u001B]8;;${url}\u0007`);
    expect(interactive.link(url)).toContain(`\u001B]8;;\u0007`);
    expect(interactive.link(url)).not.toContain("\u001B[32m");
    expect(logged.link(url)).toBe(url);
  });

  test("sanitizes URLs before emitting terminal hyperlink escapes", () => {
    const ui = new TerminalFlow({ animated: true });
    const link = ui.link("https://sb-example.vercel.run/\u001B]8;;https://evil\u0007");

    expect(link).toContain("https://sb-example.vercel.run/");
    expect(link).not.toContain("https://evil");
  });

  test("resets terminal hyperlink mode before an immediate shutdown message", () => {
    const capture = outputCapture();
    const ui = new TerminalFlow({ output: capture.output, animated: true });

    ui.outroNow("Stopped");

    expect(capture.read()).toContain("\u001B]8;;\u0007");
    expect(stripVTControlCharacters(capture.read())).toContain("└  Stopped");
  });

  test("paces settled messages on an interactive terminal", async () => {
    const capture = outputCapture();
    const gate = gatedDelay();
    const ui = new TerminalFlow({
      output: capture.output,
      animated: true,
      messageIntervalMs: 120,
      characterIntervalMs: 0,
      delay: gate.delay,
    });

    await ui.step("first");
    const second = ui.step("second");
    await settlePromises();

    expect(capture.read()).not.toContain("second");
    expect(gate.pending()).toBe(1);
    gate.release();
    await second;
    expect(capture.read()).toContain("second");
  });

  test("streams note contents character by character on an interactive terminal", async () => {
    const capture = outputCapture();
    const url = "https://sb-example.vercel.run";
    const gate = gatedDelay();
    const ui = new TerminalFlow({
      output: capture.output,
      animated: true,
      messageIntervalMs: 0,
      characterIntervalMs: 50,
      panelLineIntervalMs: 0,
      delay: gate.delay,
    });

    const note = ui.note(ui.link(url), "URL");
    await settlePromises();
    expect(stripVTControlCharacters(capture.read())).toContain("●  U");
    expect(stripVTControlCharacters(capture.read())).not.toContain("URL ");

    gate.release();
    await settlePromises();
    expect(stripVTControlCharacters(capture.read())).toContain("●  UR");
    expect(stripVTControlCharacters(capture.read())).not.toContain("URL ");
    gate.release();
    await settlePromises();
    expect(stripVTControlCharacters(capture.read())).toContain("URL ");
    gate.release();
    await settlePromises();
    expect(capture.read()).toContain(`\u001B]8;;${url}\u0007`);
    expect(capture.read()).toContain("h");
    expect(stripVTControlCharacters(capture.read())).not.toContain(url);

    let complete = false;
    void note.then(() => {
      complete = true;
    });
    for (let index = 0; index < 100 && !complete; index++) {
      gate.release();
      await settlePromises();
    }
    await note;
    expect(complete).toBe(true);
    expect(capture.read()).toContain(url);
  });
});
