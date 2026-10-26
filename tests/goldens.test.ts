import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type CliGolden,
  GOLDEN_ROOT,
  goldenPath,
  loadCases,
  type McpGolden,
  runCliCase,
  runMcpCase,
} from "./support/goldens.js";

const cases = await loadCases();

async function expected<T>(surface: "cli" | "mcp", id: string): Promise<T> {
  return JSON.parse(await readFile(goldenPath(surface, id), "utf8")) as T;
}

describe("frozen CLI and MCP goldens", () => {
  it("has exactly one golden per declared case", async () => {
    for (const surface of ["cli", "mcp"] as const) {
      const ids = cases[surface].map((testCase) => testCase.id);
      assert.equal(new Set(ids).size, ids.length, `duplicate ${surface} case id`);
      const files = (await readdir(path.join(GOLDEN_ROOT, surface))).sort();
      assert.deepEqual(files, ids.map((id) => `${id}.json`).sort());
    }
  });

  for (const testCase of cases.cli) {
    it(`cli ${testCase.id}`, { timeout: 30_000 }, async () => {
      const observed = await runCliCase(testCase);
      const golden = await expected<CliGolden>("cli", testCase.id);
      // Byte-exact streams: a reformatted JSON document or message is a contract change.
      assert.equal(observed.exitCode, golden.exitCode, "exit code");
      assert.equal(observed.stdout, golden.stdout, "stdout");
      assert.equal(observed.stderr, golden.stderr, "stderr");
    });
  }

  for (const testCase of cases.mcp) {
    it(`mcp ${testCase.id}`, { timeout: 60_000 }, async () => {
      assert.deepStrictEqual(
        await runMcpCase(testCase),
        await expected<McpGolden>("mcp", testCase.id),
      );
    });
  }
});
