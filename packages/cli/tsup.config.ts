import { createRequire } from "node:module";
import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";

const require = createRequire(import.meta.url);
const sandboxRequire = createRequire(require.resolve("@vercel/sandbox/package.json"));
const undiciAgentPath = sandboxRequire.resolve("undici/lib/dispatcher/agent.js");

type RuntimeFramework = {
  name: string;
  slug: string | null;
  experimental?: boolean;
  supersedes?: string[];
  detectors?: unknown;
  settings: { devCommand: { value: string | null } };
};

const { frameworks } = require("@vercel/frameworks") as {
  frameworks: RuntimeFramework[];
};

// The CLI only needs framework detection data. The full package also contains build metadata,
// logos, YAML/TOML readers, and functions used by Vercel deployments.
const detectionFrameworks = frameworks
  .filter((framework) => framework.detectors)
  .map(({ name, slug, experimental, supersedes, detectors, settings }) => ({
    name,
    slug,
    ...(experimental === undefined ? {} : { experimental }),
    ...(supersedes === undefined ? {} : { supersedes }),
    detectors,
    settings: { devCommand: { value: settings.devCommand.value } },
  }));

const runtimeSurfacePlugin: Plugin = {
  name: "up-runtime-surface",
  setup(build) {
    // Sandbox imports Agent from undici's public barrel, which bundles every undici feature.
    // Resolve that one import to the same Agent implementation without unrelated exports.
    build.onResolve({ filter: /^undici$/ }, (args) => {
      const importer = args.importer.replaceAll("\\", "/");
      if (!importer.endsWith("/@vercel/sandbox/dist/api-client/base-client.js")) return;
      return { path: "undici-agent", namespace: "up-runtime" };
    });
    build.onLoad({ filter: /^undici-agent$/, namespace: "up-runtime" }, () => ({
      contents: `import Agent from ${JSON.stringify(undiciAgentPath)}; export { Agent };`,
      loader: "js",
      resolveDir: "/",
    }));

    build.onResolve({ filter: /^@vercel\/frameworks$/ }, () => ({
      path: "framework-detection-data",
      namespace: "up-runtime",
    }));
    build.onLoad({ filter: /^framework-detection-data$/, namespace: "up-runtime" }, () => ({
      contents: `export const frameworks=${JSON.stringify(detectionFrameworks)};`,
      loader: "js",
    }));
  },
};

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  // Runtime libraries are devDependencies so tsup emits one self-contained CLI file.
  splitting: false,
  minify: true,
  clean: true,
  shims: true,
  esbuildPlugins: [runtimeSurfacePlugin],
  // Inline the supervisor script (and any *.txt asset) as a string.
  loader: { ".txt": "text" },
  // Bundled CommonJS dependencies need `require` available in the ESM executable.
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});
