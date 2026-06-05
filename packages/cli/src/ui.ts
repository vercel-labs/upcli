import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import pc from "picocolors";

const MESSAGE_INTERVAL_MS = 35;
const CHARACTER_INTERVAL_MS = 5;
const PANEL_LINE_INTERVAL_MS = 18;
const HYPERLINK_CLOSE = "\u001B]8;;\u0007";

export const SPINNER_FRAMES = ["◒", "◐", "◓", "◑"] as const;
export const SPINNER_INTERVAL_MS = 80;

/** Render user/filesystem text literally instead of interpreting terminal controls. */
export function sanitizeTerminalText(
  value: string,
  opts: { preserveNewlines?: boolean } = {},
): string {
  let rendered = "";
  for (const character of stripVTControlCharacters(value)) {
    if (opts.preserveNewlines && character === "\n") {
      rendered += character;
      continue;
    }
    const code = character.codePointAt(0) ?? 0;
    const control = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    rendered += control ? `\\x${code.toString(16).padStart(2, "0")}` : character;
  }
  return rendered;
}

interface TerminalOutput {
  write(chunk: string): unknown;
}

interface StreamToken {
  value: string;
  visible: boolean;
}

function visibleWidth(value: string): number {
  return stripVTControlCharacters(value).length;
}

function streamTokens(value: string): StreamToken[] {
  const tokens: StreamToken[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let cursor = 0;

  while (cursor < value.length) {
    if (value[cursor] === "\u001B") {
      const end = controlSequenceEnd(value, cursor);
      tokens.push({ value: value.slice(cursor, end), visible: false });
      cursor = end;
      continue;
    }
    const nextControl = value.indexOf("\u001B", cursor);
    const end = nextControl === -1 ? value.length : nextControl;
    for (const { segment } of segmenter.segment(value.slice(cursor, end))) {
      tokens.push({ value: segment, visible: true });
    }
    cursor = end;
  }
  return tokens;
}

function controlSequenceEnd(value: string, start: number): number {
  if (value[start + 1] === "]") {
    const bell = value.indexOf("\u0007", start + 2);
    const terminator = value.indexOf("\u001B\\", start + 2);
    if (bell !== -1 && (terminator === -1 || bell < terminator)) return bell + 1;
    if (terminator !== -1) return terminator + 2;
  }
  if (value[start + 1] === "[") {
    for (let index = start + 2; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index + 1;
    }
  }
  return start + 1;
}

export class TerminalFlow {
  private readonly animated: boolean;
  private readonly output: TerminalOutput;
  private readonly messageIntervalMs: number;
  private readonly characterIntervalMs: number;
  private readonly panelLineIntervalMs: number;
  private readonly delay: (durationMs: number) => Promise<void>;
  private lastRevealAt = 0;
  private pending = Promise.resolve();
  private activeSpinner: TerminalSpinner | undefined;
  private closed = false;

  constructor({
    animated = Boolean(process.stdout.isTTY),
    output = process.stdout,
    messageIntervalMs = MESSAGE_INTERVAL_MS,
    characterIntervalMs = CHARACTER_INTERVAL_MS,
    panelLineIntervalMs = PANEL_LINE_INTERVAL_MS,
    delay = sleep,
  }: {
    animated?: boolean;
    output?: TerminalOutput;
    messageIntervalMs?: number;
    characterIntervalMs?: number;
    panelLineIntervalMs?: number;
    delay?: (durationMs: number) => Promise<void>;
  } = {}) {
    this.animated = animated;
    this.output = output;
    this.messageIntervalMs = messageIntervalMs;
    this.characterIntervalMs = characterIntervalMs;
    this.panelLineIntervalMs = panelLineIntervalMs;
    this.delay = delay;
  }

  intro(): void {
    const badge = this.animated ? pc.bgWhite(pc.black(" up ")) : " up ";
    this.output.write(`\n${this.style("┌", pc.dim)}  ${badge}\n${this.bar()}\n`);
  }

  spinner(): TerminalSpinner {
    this.activeSpinner?.cancel();
    const spinner = new TerminalSpinner(this);
    this.activeSpinner = spinner;
    return spinner;
  }

  link(url: string): string {
    const safeUrl = sanitizeTerminalText(url);
    if (!this.animated) return safeUrl;
    const visible = pc.bold(safeUrl);
    return `\u001B]8;;${safeUrl}\u0007${visible}${HYPERLINK_CLOSE}`;
  }

  async step(message: string): Promise<void> {
    await this.reveal(async () => {
      this.output.write(`${this.style("●", pc.white)}  `);
      await this.typeText(message);
      this.output.write(`\n${this.bar()}\n`);
    });
  }

  async final(message: string): Promise<void> {
    await this.reveal(async () => {
      this.output.write(`${this.style("○", pc.white)}  `);
      await this.typeText(message);
      this.output.write("\n");
    });
  }

  async info(message: string): Promise<void> {
    await this.reveal(async () => {
      this.output.write(`${this.bar()}  `);
      await this.typeText(message);
      this.output.write(`\n${this.bar()}\n`);
    });
  }

  async warn(message: string): Promise<void> {
    await this.reveal(async () => {
      this.output.write(`${this.style("!", pc.yellow)}  `);
      await this.typeText(message);
      this.output.write(`\n${this.bar()}\n`);
    });
  }

  async error(message: string): Promise<void> {
    await this.reveal(async () => {
      this.output.write(`${this.style("■", pc.red)}  `);
      await this.typeText(message);
      this.output.write(`\n${this.bar()}\n`);
    });
  }

  async note(message: string, title: string): Promise<void> {
    const lines = message.split("\n");
    const contentWidth = Math.max(56, ...lines.map((line) => visibleWidth(line) + 2));
    const headerRule = "─".repeat(Math.max(2, contentWidth - title.length - 1));
    const empty = " ".repeat(contentWidth);
    await this.reveal(async () => {
      this.output.write(`${this.style("●", pc.white)}  `);
      await this.typeText(pc.bold(title));
      this.output.write(` ${this.style(`${headerRule}╮`, pc.dim)}\n`);
      this.output.write(`${this.bar()}  ${empty}${this.style("│", pc.dim)}\n`);
      for (const line of lines) {
        if (this.animated) await this.delay(this.panelLineIntervalMs);
        const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(line) - 2));
        this.output.write(`${this.bar()}  `);
        await this.typeText(line);
        this.output.write(`${padding}  ${this.style("│", pc.dim)}\n`);
      }
      this.output.write(`${this.bar()}  ${empty}${this.style("│", pc.dim)}\n`);
      this.output.write(
        `${this.style(`├${"─".repeat(contentWidth + 2)}╯`, pc.dim)}\n${this.bar()}\n`,
      );
    });
  }

  async outro(message: string): Promise<void> {
    await this.reveal(async () => {
      this.output.write(`${this.style("└", pc.dim)}  `);
      await this.typeText(message);
      this.output.write("\n");
      this.closed = true;
    });
  }

  outroNow(message: string): void {
    this.activeSpinner?.cancel();
    this.closed = true;
    const renderedMessage = this.animated ? message : stripVTControlCharacters(message);
    // CR + erase-line wipes the ^C echo the terminal prints on Ctrl+C before
    // our handler runs, so it never appears in the output.
    this.output.write(
      `\r[2K${this.animated ? HYPERLINK_CLOSE : ""}${this.style("└", pc.dim)}  ${renderedMessage}\n`,
    );
  }

  clearSpinner(spinner: TerminalSpinner): void {
    if (this.activeSpinner !== spinner) return;
    this.activeSpinner = undefined;
    if (this.animated) this.output.write("\r\u001B[2K");
  }

  renderSpinner(frame: string, message: string): void {
    if (!this.animated || this.closed) return;
    this.output.write(`\r\u001B[2K${pc.white(frame)}  ${message}`);
  }

  isAnimated(): boolean {
    return this.animated;
  }

  private style(value: string, format: (text: string) => string): string {
    return this.animated ? format(value) : value;
  }

  private bar(): string {
    return this.style("│", pc.dim);
  }

  private async reveal(render: () => void | Promise<void>): Promise<void> {
    const next = this.pending.then(async () => {
      if (this.closed) return;
      await this.waitForReveal();
      await render();
      this.lastRevealAt = Date.now();
    });
    this.pending = next.catch(() => {});
    await next;
  }

  private async typeText(value: string): Promise<void> {
    if (!this.animated) {
      this.output.write(stripVTControlCharacters(value));
      return;
    }
    let emittedVisibleToken = false;
    for (const token of streamTokens(value)) {
      if (this.closed) return;
      if (token.visible && emittedVisibleToken && this.characterIntervalMs > 0) {
        await this.delay(this.characterIntervalMs);
      }
      this.output.write(token.value);
      if (token.visible) emittedVisibleToken = true;
    }
  }

  private async waitForReveal(): Promise<void> {
    if (!this.animated) return;
    const wait = this.messageIntervalMs - (Date.now() - this.lastRevealAt);
    if (wait > 0) await this.delay(wait);
  }
}

export class TerminalSpinner {
  private interval: NodeJS.Timeout | undefined;
  private textInterval: NodeJS.Timeout | undefined;
  private frame = 0;
  private messageText = "";
  private tokens: StreamToken[] = [];

  constructor(private readonly flow: TerminalFlow) {}

  start(message: string): void {
    if (!this.flow.isAnimated()) return;
    if (this.interval) clearInterval(this.interval);
    if (this.textInterval) clearInterval(this.textInterval);
    this.interval = undefined;
    this.textInterval = undefined;
    this.setMessage(message);
    this.interval = setInterval(() => this.draw(), SPINNER_INTERVAL_MS);
    this.interval.unref();
  }

  message(message: string): void {
    if (!this.flow.isAnimated()) return;
    this.setMessage(message);
  }

  async stop(message: string): Promise<void> {
    this.cancel();
    await this.flow.step(message);
  }

  async fail(message: string): Promise<void> {
    this.cancel();
    await this.flow.error(message);
  }

  cancel(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.textInterval) clearInterval(this.textInterval);
    this.interval = undefined;
    this.textInterval = undefined;
    this.flow.clearSpinner(this);
  }

  private setMessage(message: string): void {
    if (this.textInterval) clearInterval(this.textInterval);
    this.textInterval = undefined;
    this.messageText = "";
    this.tokens = streamTokens(message);
    this.advanceText();
    this.draw();
    if (this.tokens.length === 0) return;
    this.textInterval = setInterval(() => {
      this.advanceText();
      this.draw();
      if (this.tokens.length === 0 && this.textInterval) {
        clearInterval(this.textInterval);
        this.textInterval = undefined;
      }
    }, CHARACTER_INTERVAL_MS);
    this.textInterval.unref();
  }

  private advanceText(): void {
    const token = this.tokens.shift();
    if (!token) return;
    this.messageText += token.value;
    while (this.tokens[0] && !this.tokens[0].visible) {
      this.messageText += this.tokens.shift()?.value ?? "";
    }
  }

  private draw(): void {
    const frame = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
    this.flow.renderSpinner(frame, this.messageText);
    this.frame++;
  }
}

/** Open a URL in the user's default browser, cross-platform. Best-effort. */
export function openUrl(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.unref();
  } catch {
    // Ignore: opening a browser is a convenience, not a requirement.
  }
}

/** Copy text to the clipboard. Returns whether it succeeded. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const commands =
    process.platform === "darwin"
      ? [{ command: "pbcopy", args: [] }]
      : process.platform === "win32"
        ? [{ command: "clip", args: [] }]
        : process.platform === "android"
          ? [{ command: "termux-clipboard-set", args: [] }]
          : [
              { command: "wl-copy", args: [] },
              { command: "xsel", args: ["--clipboard", "--input"] },
              { command: "xclip", args: ["-selection", "clipboard", "-in"] },
              { command: "clip.exe", args: [] },
            ];

  for (const { command, args } of commands) {
    const copied = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
        child.once("error", () => finish(false));
        child.once("close", (code) => finish(code === 0));
        if (!child.stdin) return finish(false);
        child.stdin.once("error", () => finish(false));
        child.stdin.end(text);
      } catch {
        finish(false);
      }
    });
    if (copied) return true;
  }
  return false;
}
