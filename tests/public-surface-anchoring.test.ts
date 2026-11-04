/** Ratchet for ADR 0003: in 3.0.0 the CLI and the MCP server are the public contract, so tests reach
 * them through the built package (`tests/support/public-surface.ts`), never through their source
 * modules. Only the files below may still import those modules, each for a reason the process
 * boundary cannot serve. */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PACKAGE_ROOT } from "./support/goldens.js";

const TESTS_ROOT = path.join(PACKAGE_ROOT, "tests");
const SOURCE_SURFACES = [/^src\/cli\.[cm]?[jt]s$/u, /^src\/mcp\//u];

const IN_PROCESS_ALLOWLIST = new Map<string, string>([
  [
    "bun-preflight-diagnostics.test.ts",
    "mocks node:child_process inside the CLI process to script the Bun probe",
  ],
  [
    "developer-experience.test.ts",
    "injects setup and demo dependencies, and checks the refusals of a source (unbuilt) run",
  ],
  [
    "naming-migration.test.ts",
    "pins the createTestForgeServer alias of the JS API removed in 3.0.0",
  ],
]);

async function testModules(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "goldens" && entry.name !== "replay-corpus") {
        files.push(...(await testModules(full)));
      }
    } else if (/\.[cm]?[jt]s$/u.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** Relative specifiers of static imports, re-exports and dynamic imports that land on a source surface. */
function sourceSurfaceImports(file: string, source: string): string[] {
  const specifiers = source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gmu,
  );
  return [...specifiers]
    .map((match) => match[1] as string)
    .filter((specifier) => specifier.startsWith("."))
    .filter((specifier) => {
      const target = path
        .relative(PACKAGE_ROOT, path.resolve(path.dirname(file), specifier))
        .split(path.sep)
        .join("/");
      return SOURCE_SURFACES.some((surface) => surface.test(target));
    });
}

test("tests reach the CLI and MCP server only through the built package, outside the allowlist", async () => {
  const importing = new Map<string, string[]>();
  for (const file of await testModules(TESTS_ROOT)) {
    const found = sourceSurfaceImports(file, await readFile(file, "utf8"));
    if (found.length > 0) {
      importing.set(path.relative(TESTS_ROOT, file).split(path.sep).join("/"), found);
    }
  }

  const unlisted = [...importing].filter(([file]) => !IN_PROCESS_ALLOWLIST.has(file));
  assert.deepEqual(unlisted, [], "use tests/support/public-surface.ts instead of a source module");
  const stale = [...IN_PROCESS_ALLOWLIST.keys()].filter((file) => !importing.has(file));
  assert.deepEqual(stale, [], "remove allowlist entries that no longer import a source surface");
});
