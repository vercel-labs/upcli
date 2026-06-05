import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // This landing site is a self-contained project (its own lockfile + node_modules).
  // Pin the file-tracing root so Next does not climb to a stray lockfile higher up.
  outputFileTracingRoot: here,
  // Do not advertise the framework in an X-Powered-By response header.
  poweredByHeader: false,
};

export default nextConfig;
