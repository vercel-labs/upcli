import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export interface EnvFile {
  rel: string;
  values: Record<string, string>;
}

/**
 * Cap the dotenv read. A cloned repo can ship an `.env.local`, and the prompt
 * to inject it defaults to yes, so a hostile oversized file must not be read
 * whole into memory. No real dotenv approaches this; reject rather than buffer.
 */
const MAX_ENV_FILE_BYTES = 4 * 1024 * 1024;

function validateRelativeEnvPath(input: string): string {
  const normalized = path.normalize(input);
  if (
    !input ||
    input.includes("\0") ||
    path.isAbsolute(input) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Unsafe env file path: ${JSON.stringify(input)}.`);
  }
  return normalized;
}

async function readRegularFileNoFollow(abs: string): Promise<string> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(abs, constants.O_RDONLY | noFollow);
  try {
    const current = await handle.stat();
    if (!current.isFile()) {
      throw new Error(`Env file is not a regular file: ${JSON.stringify(abs)}.`);
    }
    if (current.size > MAX_ENV_FILE_BYTES) {
      throw new Error(`Env file is too large (limit ${MAX_ENV_FILE_BYTES} bytes): ${abs}.`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function parseQuotedValue(value: string, quote: "'" | '"', line: number): string {
  let end = -1;
  for (let index = 1; index < value.length; index++) {
    if (value[index] !== quote) continue;
    if (quote === '"' && escapedByOddBackslashes(value, index)) continue;
    end = index;
    break;
  }
  if (end === -1) throw new Error(`Unterminated quoted value in env file at line ${line}.`);
  const trailing = value.slice(end + 1).trim();
  if (trailing && !trailing.startsWith("#")) {
    throw new Error(`Unexpected text after quoted env value at line ${line}.`);
  }
  const inner = value.slice(1, end);
  if (quote === "'") return inner;
  return inner.replace(/\\([nrt"\\])/g, (_match, escaped: string) => {
    switch (escaped) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        return escaped;
    }
  });
}

function escapedByOddBackslashes(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function hasUnescapedClosingDoubleQuote(value: string): boolean {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === '"' && !escapedByOddBackslashes(value, i)) return true;
  }
  return false;
}

export function parseDotenv(text: string): Record<string, string> {
  // Environment variable names can legally include keys such as `__proto__`;
  // use a null-prototype map so those names are stored literally.
  const values: Record<string, string> = Object.create(null);
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const equals = withoutExport.indexOf("=");
    if (equals <= 0) throw new Error(`Invalid env assignment at line ${lineNumber}.`);
    const key = withoutExport.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid env key ${JSON.stringify(key)} at line ${lineNumber}.`);
    }
    const rawValue = withoutExport.slice(equals + 1).trim();
    if (rawValue.startsWith('"')) {
      // Accumulate continuation lines for multiline values (e.g. PEM keys).
      let fullValue = rawValue;
      while (!hasUnescapedClosingDoubleQuote(fullValue)) {
        index++;
        if (index >= lines.length) {
          throw new Error(`Unterminated quoted value in env file at line ${lineNumber}.`);
        }
        fullValue += `\n${lines[index] ?? ""}`;
      }
      values[key] = parseQuotedValue(fullValue, '"', lineNumber);
      continue;
    }
    if (rawValue.startsWith("'")) {
      values[key] = parseQuotedValue(rawValue, "'", lineNumber);
      continue;
    }
    const comment = rawValue.search(/\s#/);
    values[key] = (comment === -1 ? rawValue : rawValue.slice(0, comment)).trim();
  }
  return values;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function readEnvFile(dir: string, input: string): Promise<EnvFile> {
  const rel = validateRelativeEnvPath(input);
  const abs = path.resolve(dir, rel);
  const relative = path.relative(dir, abs).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Env file must stay inside the project: ${JSON.stringify(input)}.`);
  }
  if ((await lstat(abs)).isSymbolicLink()) {
    throw new Error(`Env file is not a regular file: ${JSON.stringify(abs)}.`);
  }
  const [realDir, realAbs] = await Promise.all([realpath(dir), realpath(abs)]);
  if (!isWithin(realDir, realAbs)) {
    throw new Error(`Env file must stay inside the project: ${JSON.stringify(input)}.`);
  }
  return { rel: relative, values: parseDotenv(await readRegularFileNoFollow(abs)) };
}

/**
 * `.env.local` is the conventional local-only dotenv file for most JS apps.
 * We only auto-suggest a regular file and do not follow symlinks here.
 */
export async function findDefaultEnvFile(dir: string): Promise<string | undefined> {
  const rel = ".env.local";
  try {
    return (await lstat(path.join(dir, rel))).isFile() ? rel : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}
