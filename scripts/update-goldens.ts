#!/usr/bin/env node
/** Rewrite the CLI and MCP goldens from the current build. A rewritten golden is a changed oracle:
 * review every diff it produces before committing it. */
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GOLDEN_ROOT,
  goldenPath,
  loadCases,
  PACKAGE_ROOT,
  runCliCase,
  runMcpCase,
} from "../tests/support/goldens.js";

const cases = await loadCases();
for (const surface of ["cli", "mcp"] as const) {
  await rm(path.join(GOLDEN_ROOT, surface), { recursive: true, force: true });
  await mkdir(path.join(GOLDEN_ROOT, surface), { recursive: true });
}
for (const testCase of cases.cli) {
  await writeFile(
    goldenPath("cli", testCase.id),
    `${JSON.stringify(await runCliCase(testCase), null, 2)}\n`,
  );
}
for (const testCase of cases.mcp) {
  await writeFile(
    goldenPath("mcp", testCase.id),
    `${JSON.stringify(await runMcpCase(testCase), null, 2)}\n`,
  );
}
const biome = spawnSync(
  process.execPath,
  [
    path.join(PACKAGE_ROOT, "node_modules", "@biomejs", "biome", "bin", "biome"),
    "format",
    "--write",
    GOLDEN_ROOT,
  ],
  { stdio: "inherit" },
);
process.exitCode = biome.status ?? 1;
process.stdout.write(`${cases.cli.length} CLI and ${cases.mcp.length} MCP goldens written\n`);
