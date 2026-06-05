import { watch } from "node:fs";
import path from "node:path";
import { createMandatoryIgnore } from "./sync.js";

export interface WatchHandle {
  close(): Promise<void>;
}

interface NativeWatcher {
  close(): void;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface WatchOptions {
  includeSensitiveConfig?: boolean;
  debounceMs?: number;
  pollIntervalMs?: number;
  onFallback?: (err: Error) => void;
  onChange: (source: "event" | "poll") => void;
  /** Test seam for failures opening an operating-system watcher. */
  createWatcher?: (
    dir: string,
    listener: (eventType: string, filename: string | Buffer | null) => void,
  ) => NativeWatcher;
}

/** Notify once per burst of syncable local changes. */
export async function watchProject(dir: string, opts: WatchOptions): Promise<WatchHandle> {
  // Reconciliation evaluates nested `.gitignore` rules; prune only paths that
  // can never sync so a nested negation or changed rule still triggers it.
  const ig = createMandatoryIgnore({ includeSensitiveConfig: opts.includeSensitiveConfig });
  const toRel = (p: string) => path.relative(dir, p).split(path.sep).join("/");
  let timer: NodeJS.Timeout | undefined;
  let poller: NodeJS.Timeout | undefined;
  let watcher: NativeWatcher | undefined;
  let closed = false;

  const schedule = (source: "event" | "poll") => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => opts.onChange(source), opts.debounceMs ?? 120);
  };

  const poll = (err: Error) => {
    if (closed || poller) return;
    try {
      watcher?.close();
    } catch {
      // A watcher that already failed may already be closed.
    }
    watcher = undefined;
    opts.onFallback?.(err);
    poller = setInterval(() => schedule("poll"), opts.pollIntervalMs ?? 2000);
    poller.unref();
  };

  const onEvent = (_eventType: string, filename: string | Buffer | null) => {
    if (!filename) {
      schedule("event");
      return;
    }
    const rel = toRel(path.join(dir, filename.toString()));
    if (!rel || rel.startsWith("..") || !ig.ignores(rel)) schedule("event");
  };

  try {
    const create =
      opts.createWatcher ??
      ((target: string, listener: (eventType: string, filename: string | Buffer | null) => void) =>
        watch(target, { recursive: true }, listener));
    watcher = create(dir, onEvent);
    watcher.on("error", poll);
  } catch (err) {
    poll(err instanceof Error ? err : new Error(String(err)));
  }

  return {
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      watcher?.close();
    },
  };
}
