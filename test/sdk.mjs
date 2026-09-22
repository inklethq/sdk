import { createRequire } from "node:module";
import { describe } from "node:test";

/**
 * Which build a behaviour suite runs against.
 *
 * Every suite loads the SDK through here instead of naming dist/esm itself, so
 * that test/cjs.test.mjs can import the same file a second time as
 * `./client.test.mjs?build=cjs`. The query makes a separate module instance,
 * and its `import.meta.url` asks for the CommonJS build — the one `require`
 * resolves to — rather than sharing the ESM run's.
 */
export function buildOf(moduleUrl) {
  return new URL(moduleUrl).searchParams.get("build") === "cjs" ? "cjs" : "esm";
}

export async function loadSdk(moduleUrl) {
  return buildOf(moduleUrl) === "cjs"
    ? createRequire(import.meta.url)("../dist/cjs/index.js")
    : import("../dist/esm/index.js");
}

/**
 * `describe`, with the build in the suite name when it is CommonJS, so a
 * failure says which build it came from.
 */
export function describeFor(moduleUrl) {
  return buildOf(moduleUrl) === "cjs"
    ? (name, ...rest) => describe(`${name} (CommonJS)`, ...rest)
    : describe;
}
