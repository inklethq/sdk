import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

describe("published package exports", () => {
  it("loads through the ESM import condition", async () => {
    const sdk = await import("@inklethq/sdk");

    assert.equal(typeof sdk.Inklet, "function");
    assert.equal(sdk.Inklet, sdk.InkletClient);
    assert.equal(typeof sdk.AssetsResource, "function");
    assert.equal(typeof sdk.ContentsResource, "function");
    assert.equal(typeof sdk.AnalysesResource, "function");
    assert.equal(typeof sdk.DisplaysResource, "function");
    assert.equal(typeof sdk.PresentationsResource, "function");
    assert.equal(typeof sdk.PushResource, "function");
    assert.equal(typeof sdk.RequestTimeoutError, "function");
  });

  it("loads through the CommonJS require condition", () => {
    const require = createRequire(import.meta.url);
    const sdk = require("@inklethq/sdk");

    assert.equal(typeof sdk.Inklet, "function");
    assert.equal(sdk.Inklet, sdk.InkletClient);
    assert.equal(typeof sdk.PushResource, "function");
    assert.equal(typeof sdk.MultiplePresentationsError, "function");
  });

  it("exports its package.json", () => {
    const require = createRequire(import.meta.url);
    assert.equal(require("@inklethq/sdk/package.json").name, "@inklethq/sdk");
  });

  it("gives each condition declarations of its own module format", () => {
    // A `.d.ts` is ESM or CommonJS by the nearest package.json, like a `.js`,
    // so `require` needs declarations under dist/cjs and its commonjs marker.
    const { import: esm, require: cjs } = manifest.exports["."];
    for (const [condition, format] of [[esm, "module"], [cjs, "commonjs"]]) {
      assert.equal(dirname(condition.types), dirname(condition.default));
      assert.ok(existsSync(resolve(root, condition.types)), condition.types);
      assert.equal(nearestType(resolve(root, condition.types)), format, condition.types);
    }
    assert.equal(manifest.types, cjs.types);
  });

  it("ships the sources its source and declaration maps point at", () => {
    const shipped = manifest.files.map((entry) => resolve(root, entry));
    const maps = ["dist/esm", "dist/cjs"].flatMap((directory) =>
      readdirSync(resolve(root, directory))
        .filter((name) => name.endsWith(".map"))
        .map((name) => resolve(root, directory, name)),
    );
    assert.ok(maps.length > 0);

    for (const map of maps) {
      const { sources } = JSON.parse(readFileSync(map, "utf8"));
      for (const source of sources) {
        const target = resolve(dirname(map), source);
        assert.ok(existsSync(target), `${relative(root, map)} -> ${source}`);
        assert.ok(
          shipped.some((entry) => !relative(entry, target).startsWith("..")),
          `${relative(root, target)} is not in package.json files`,
        );
      }
    }
  });
});

function nearestType(file) {
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    const candidate = resolve(directory, "package.json");
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf8")).type ?? "commonjs";
    }
  }
}
