import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const publicDir = new URL("../public/", import.meta.url);
const installScript = await readFile(new URL("install.sh", publicDir), "utf8");
const currentVersion = installScript.match(/^VERSION="\$\{UP_VERSION:-(v[^}]+)\}"$/m)?.[1];

if (!currentVersion) {
  throw new Error("install.sh must declare a default UP_VERSION.");
}

const versionPlaceholder = "$" + "{VERSION}";
const expectedDownloadRoot = `https://cdn.upcli.dev/releases/${versionPlaceholder}`;
if (!installScript.includes(expectedDownloadRoot)) {
  throw new Error("install.sh must download releases from cdn.upcli.dev.");
}

const releasesDir = new URL("releases/", publicDir);
const releaseNames = (await readdir(releasesDir)).sort();

if (!releaseNames.includes(currentVersion)) {
  throw new Error(`Default release ${currentVersion} is missing from public/releases.`);
}

for (const releaseName of releaseNames) {
  const releaseDir = new URL(`${releaseName}/`, releasesDir);
  if (!(await stat(releaseDir)).isDirectory()) {
    continue;
  }

  const bundleName = "up.mjs";
  const bundle = await readFile(new URL(bundleName, releaseDir));
  const checksums = await readFile(new URL("checksums.txt", releaseDir), "utf8");
  const re = new RegExp(String.raw`^([0-9a-fA-F]{64})\s+${bundleName}$`, "m");
  const matches = checksums
    .split(/\r?\n/)
    .map((line) => line.match(re))
    .filter(Boolean);

  if (matches.length !== 1) {
    const checksumPath = join("public", "releases", releaseName, "checksums.txt");
    throw new Error(`${checksumPath} must contain exactly one ${bundleName} SHA-256 entry.`);
  }

  const actual = createHash("sha256").update(bundle).digest("hex");
  const expected = matches[0][1].toLowerCase();
  if (actual !== expected) {
    throw new Error(`${releaseName} checksum mismatch: expected ${expected}, got ${actual}.`);
  }
}
