import path from "node:path";

const MAX_DEPENDENCY_PATTERN_LENGTH = 4096;

export function validateDependencyFilePattern(pattern: string, from = "dependencyFiles"): string {
  const normalized = path.posix.normalize(pattern);
  if (
    !pattern ||
    pattern.includes("\0") ||
    path.posix.isAbsolute(pattern) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== pattern ||
    pattern.length > MAX_DEPENDENCY_PATTERN_LENGTH
  ) {
    throw new Error(`${from}: unsafe dependency file pattern ${JSON.stringify(pattern)}.`);
  }
  return pattern;
}

type GlobToken =
  | { kind: "literal"; value: string }
  | { kind: "star" }
  | { kind: "globstar" }
  | { kind: "qmark" };

function tokenizeGlob(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const character = pattern.charAt(i);
    if (character === "*" && pattern[i + 1] === "*") {
      tokens.push({ kind: "globstar" });
      i += 1;
      continue;
    }
    if (character === "*") {
      tokens.push({ kind: "star" });
      continue;
    }
    if (character === "?") {
      tokens.push({ kind: "qmark" });
      continue;
    }
    tokens.push({ kind: "literal", value: character });
  }
  return tokens;
}

/**
 * Match a relative glob without converting it to a backtracking regular
 * expression. A checked-in `up.config.json` is not trusted until after it is
 * parsed, so this matcher needs predictable work even for hostile patterns.
 */
function globMatches(pattern: string, rel: string): boolean {
  const tokens = tokenizeGlob(pattern);
  const last = rel.length;
  let next = new Uint8Array(last + 1);
  let nextNext: Uint8Array | undefined;
  next[last] = 1;

  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (!token) continue;
    const nextToken = tokens[i + 1];
    const current = new Uint8Array(last + 1);
    for (let j = last; j >= 0; j--) {
      if (token.kind === "literal") {
        current[j] = j < last && rel[j] === token.value ? (next[j + 1] ?? 0) : 0;
      } else if (token.kind === "qmark") {
        current[j] = j < last && rel[j] !== "/" ? (next[j + 1] ?? 0) : 0;
      } else if (token.kind === "star") {
        current[j] = (next[j] ?? 0) || (j < last && rel[j] !== "/" ? (current[j + 1] ?? 0) : 0);
      } else if (nextToken?.kind === "literal" && nextToken.value === "/") {
        // `**/` can match zero path segments as well as any number of them.
        current[j] = (nextNext?.[j] ?? 0) || (j < last ? (current[j + 1] ?? 0) : 0);
      } else {
        current[j] = (next[j] ?? 0) || (j < last ? (current[j + 1] ?? 0) : 0);
      }
    }
    nextNext = next;
    next = current;
  }

  return (next[0] ?? 0) === 1;
}

export function dependencyInputMatches(patterns: string[], rel: string): boolean {
  for (const pattern of patterns) {
    if (pattern.includes("*") || pattern.includes("?")) {
      if (globMatches(pattern, rel)) return true;
    } else if (pattern === rel) {
      return true;
    }
  }
  return false;
}
