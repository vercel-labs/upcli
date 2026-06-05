import { stat } from "node:fs/promises";

const maxBytes = 650_000;
const { size } = await stat(new URL("../dist/cli.js", import.meta.url));

if (size > maxBytes) {
  throw new Error(`CLI bundle is ${size} bytes; expected at most ${maxBytes} bytes.`);
}

console.log(`CLI bundle size: ${size} bytes (limit: ${maxBytes}).`);
