import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

function staticDependencies(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s+|^[\t ]*import\s+)["']([^"']+)["']/gmu)].map((match) => {
    const dependency = match[1];
    assert.ok(dependency);
    return dependency;
  });
}

function importDeclarationCount(source: string): number {
  return [...source.matchAll(/^[\t ]*import\b/gmu)].length;
}

describe("static conformance v1 oracle", () => {
  it("locks all six non-proof target outcomes as explicit RED cases", async () => {
    const bundle = JSON.parse(await readFile("conformance/v1/bundle.json", "utf8"));
    assert.equal(bundle.cases.length, 14);
    for (const outcome of [
      "compile-failure",
      "collection-failure",
      "timeout",
      "process-crash",
      "infra-error",
      "no-test-discovered",
    ]) {
      const item = bundle.cases.find(
        (candidate: { id?: unknown }) => candidate.id === `decide-${outcome}-non-kill`,
      );
      assert.equal(item?.operation, "DECIDE_EVIDENCE");
      assert.equal(item?.outcome, "RED");
    }
  });

  it("keeps the checker independent from generators, tests, and schema registries", async () => {
    const source = await readFile("scripts/check-conformance-v1.ts", "utf8");
    assert.doesNotMatch(source, /\b(?:import|require)\s*\(/);
    const dependencies = staticDependencies(source);
    assert.equal(dependencies.length, importDeclarationCount(source));
    assert.deepStrictEqual(dependencies.sort(), [
      "../src/index.js",
      "./conformance-v1-lock.js",
      "node:assert/strict",
      "node:crypto",
      "node:fs/promises",
      "node:path",
    ]);
    const hostileSideEffectImport = ' \timport "./generate-conformance-v1.js";';
    assert.deepStrictEqual(staticDependencies(hostileSideEffectImport), [
      "./generate-conformance-v1.js",
    ]);
    assert.equal(importDeclarationCount(hostileSideEffectImport), 1);
  });

  it("keeps generation outside pnpm check and requires an explicit canonical-write flag", async () => {
    const generator = await readFile("scripts/generate-conformance-v1.ts", "utf8");
    const packageDocument = JSON.parse(await readFile("package.json", "utf8"));

    assert.match(generator, /OUTPUT_DIRECTORY_REQUIRED/);
    assert.match(generator, /--maintainer-allow-canonical/);
    assert.match(generator, /CANONICAL_CONFORMANCE_WRITE_FORBIDDEN/);
    assert.doesNotMatch(generator, /conformance-v1-lock/);
    assert.match(packageDocument.scripts.check, /check:conformance/);
    assert.doesNotMatch(packageDocument.scripts.check, /generate-conformance/);
    assert.equal(
      packageDocument.scripts["check:conformance"],
      "tsx scripts/check-conformance-v1.ts",
    );
  });

  it("regenerates digest entries for every published schema", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-conformance-gen-"));
    const outputDirectory = path.join(temporaryRoot, "candidate");
    try {
      const generated = spawnSync(
        process.execPath,
        [
          "node_modules/tsx/dist/cli.mjs",
          "scripts/generate-conformance-v1.ts",
          "--output-dir",
          outputDirectory,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      assert.equal(generated.status, 0, generated.stderr || generated.stdout);

      const expectedDigests = JSON.parse(
        await readFile(path.join(outputDirectory, "schemas", "expected-digests.json"), "utf8"),
      ) as { schemas?: Array<{ path?: unknown }> };
      const generatedPaths = expectedDigests.schemas?.map(({ path: schemaPath }) => schemaPath);
      const publishedPaths = JSON.parse(
        await readFile("conformance/v1/schemas/expected-digests.json", "utf8"),
      ).schemas.map(({ path: schemaPath }: { path: string }) => schemaPath);
      assert.deepEqual(generatedPaths, publishedPaths);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("keeps mutating negative witnesses explicit and outside pnpm check", async () => {
    const runner = await readFile("scripts/run-conformance-negative-witnesses.ts", "utf8");
    const packageDocument = JSON.parse(await readFile("package.json", "utf8"));

    assert.match(runner, /mkdtemp/);
    assert.match(runner, /WITNESS_TARGET_INSIDE_REPOSITORY/);
    assert.match(runner, /RAW_FIXTURE_DIGEST_MUTATION/);
    assert.match(runner, /CONFORMANCE_NON_KILL_ASSERTION_FAILED/);
    for (const outcome of [
      "COMPILE_FAILURE",
      "COLLECTION_FAILURE",
      "TIMEOUT",
      "PROCESS_CRASH",
      "INFRA_ERROR",
      "NO_TEST_DISCOVERED",
    ]) {
      assert.match(runner, new RegExp(`NON_KILL_SEMANTIC_ASSERTION_${outcome}`));
    }
    assert.match(runner, /removed/);
    assert.equal(
      packageDocument.scripts["witness:conformance"],
      "tsx scripts/run-conformance-negative-witnesses.ts",
    );
    assert.doesNotMatch(packageDocument.scripts.check, /witness:conformance/);
  });
});
