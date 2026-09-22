import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = resolve(projectRoot, "dist");

if (dirname(distDirectory) !== projectRoot) {
  throw new Error("Refusing to clean an unexpected build directory.");
}

rmSync(distDirectory, { recursive: true, force: true });

const compiler = resolve(projectRoot, "node_modules/typescript/bin/tsc");
// Each build emits its own declarations next to its JavaScript. The files are
// the same text, but TypeScript reads a `.d.ts` as ESM or CommonJS from the
// nearest package.json, exactly as Node.js does for `.js`: `require` users
// need declarations that sit under dist/cjs and its `"type": "commonjs"`
// marker, or a `.cts` importer is told the package is ESM-only (TS1479).
for (const config of ["tsconfig.build.esm.json", "tsconfig.build.cjs.json"]) {
  const result = spawnSync(process.execPath, [compiler, "--project", config], {
    cwd: projectRoot,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// The package itself is `"type": "module"`, so dist/cjs needs its own marker
// for both Node.js and TypeScript to read its files as CommonJS.
const commonJsDirectory = resolve(distDirectory, "cjs");
mkdirSync(commonJsDirectory, { recursive: true });
writeFileSync(
  resolve(commonJsDirectory, "package.json"),
  `${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
);
