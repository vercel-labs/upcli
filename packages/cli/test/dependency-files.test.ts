import { describe, expect, test } from "vitest";
import { dependencyInputMatches, validateDependencyFilePattern } from "../src/dependency-files.js";

describe("dependency file patterns", () => {
  test("matches exact paths and relative glob inputs", () => {
    expect(dependencyInputMatches(["package.json"], "package.json")).toBe(true);
    expect(dependencyInputMatches(["**/package.json"], "package.json")).toBe(true);
    expect(dependencyInputMatches(["**/package.json"], "apps/web/package.json")).toBe(true);
    expect(dependencyInputMatches(["apps/*/pnpm-lock.yaml"], "apps/web/pnpm-lock.yaml")).toBe(true);
    expect(dependencyInputMatches(["**/package.json"], "apps/web/package-lock.json")).toBe(false);
  });

  test("rejects traversal and absolute dependency patterns", () => {
    expect(() => validateDependencyFilePattern("../package.json")).toThrow(
      "unsafe dependency file pattern",
    );
    expect(() => validateDependencyFilePattern("/package.json")).toThrow(
      "unsafe dependency file pattern",
    );
    expect(() => validateDependencyFilePattern("apps/../package.json")).toThrow(
      "unsafe dependency file pattern",
    );
  });

  test("matches adversarial globs without regex backtracking", () => {
    const pattern = `${"a*".repeat(32)}X`;
    expect(dependencyInputMatches([pattern], "a".repeat(64))).toBe(false);
  });

  test("rejects dependency patterns that cannot be useful local paths", () => {
    expect(() => validateDependencyFilePattern("a".repeat(4097))).toThrow(
      "unsafe dependency file pattern",
    );
  });
});
