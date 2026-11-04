import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAssertLedgerServer, createTestForgeServer } from "../src/mcp/index.js";
import { AssertLedger, TestForge } from "../src/sdk/index.js";
import { connectPublicMcp, listedInputSchemas } from "./support/public-surface.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixtureRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-naming-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"name":"fixture","type":"module"}\n');
  await writeFile(path.join(root, "src", "index.js"), "export const ready = true;\n");
  return root;
}

describe("package identity", () => {
  it("installs both binary names against the identical CLI entrypoint", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    );

    assert.equal(packageJson.name, "assertledger");
    assert.equal(packageJson.bin.assertledger, "dist/cli.js");
    assert.equal(packageJson.bin.testforge, "dist/cli.js");
    assert.equal(packageJson.bin.assertledger, packageJson.bin.testforge);
    assert.ok(packageJson.files.includes("conformance"));
  });
});

describe("SDK naming compatibility", () => {
  it("exposes TestForge as a subclass alias of AssertLedger with an identical surface", () => {
    assert.equal(Object.getPrototypeOf(TestForge), AssertLedger);
    assert.ok(TestForge.prototype instanceof AssertLedger);

    const preferred = new AssertLedger();
    const legacy = new TestForge();

    assert.deepEqual(legacy.schema("replay-result"), preferred.schema("replay-result"));
  });

  it("keeps the schema wire domain and structured-command adapter kind literal frozen", () => {
    const sdk = new AssertLedger();

    const replayResultSchema = sdk.schema("replay-result");
    assert.equal(replayResultSchema.$id, "https://testforge.dev/schemas/replay-result.v1.json");

    const repositoryAnalysisSchema = sdk.schema("repository-analysis");
    assert.match(JSON.stringify(repositoryAnalysisSchema), /testforge-command/);
  });

  it("produces byte-identical repository analysis through AssertLedger and TestForge", async () => {
    const root = await fixtureRepository();

    const preferred = await new AssertLedger().analyze(root);
    const legacy = await new TestForge().analyze(root);

    assert.deepEqual(legacy, preferred);
  });
});

describe("MCP naming compatibility", () => {
  it("aliases createTestForgeServer to the exact createAssertLedgerServer function", () => {
    assert.equal(createTestForgeServer, createAssertLedgerServer);
  });

  it("registers every read-only tool under assertledger_* and testforge_* bound to the identical config", async () => {
    const client = await connectPublicMcp();
    const listed = await listedInputSchemas(client);
    await client.close();
    const pairs = [
      "analyze",
      "benchmark",
      "benchmark_acquire_replay",
      "benchmark_replay",
      "corpus_allocate",
      "corpus_allocation_replay",
      "export",
      "export_replay",
      "profile",
      "profile_replay",
      "profile_v2",
      "profile_v2_replay",
      "provider",
      "replay",
      "schema",
    ];

    for (const suffix of pairs) {
      const preferred = listed.get(`assertledger_${suffix}`);
      const legacy = listed.get(`testforge_${suffix}`);
      assert.ok(preferred, `missing assertledger_${suffix}`);
      assert.deepEqual(
        preferred,
        legacy,
        `assertledger_${suffix} diverges from testforge_${suffix}`,
      );
    }
  });

  it("registers assertledger_verify only when the operator grants unsafe execution", async () => {
    const readOnly = await connectPublicMcp();
    const readOnlyTools = await listedInputSchemas(readOnly);
    await readOnly.close();
    assert.ok(readOnlyTools.has("assertledger_analyze"));
    assert.equal(readOnlyTools.has("assertledger_verify"), false);

    const unsafe = await connectPublicMcp({ allowUnsafeExecution: true });
    const unsafeTools = await listedInputSchemas(unsafe);
    await unsafe.close();
    const preferred = unsafeTools.get("assertledger_verify");
    const legacy = unsafeTools.get("testforge_verify");
    assert.ok(preferred);
    assert.deepEqual(preferred, legacy);
  });

  it("returns byte-identical output when the preferred and legacy tool names are called", async () => {
    const client = await connectPublicMcp({ name: "naming-migration-test" });

    try {
      const preferred = await client.callTool({
        name: "assertledger_schema",
        arguments: { name: "verification-request" },
      });
      const legacy = await client.callTool({
        name: "testforge_schema",
        arguments: { name: "verification-request" },
      });

      assert.equal(preferred.isError, undefined);
      assert.equal(legacy.isError, undefined);
      assert.deepEqual(preferred.structuredContent, legacy.structuredContent);
    } finally {
      await client.close();
    }
  });

  it("confines both the preferred and legacy analyze tool to the identical allowed repository root", async () => {
    const allowed = await fixtureRepository();
    const forbidden = await fixtureRepository();
    const client = await connectPublicMcp({ root: allowed, name: "naming-migration-test" });

    try {
      const preferredAccepted = await client.callTool({
        name: "assertledger_analyze",
        arguments: { root: allowed },
      });
      const legacyAccepted = await client.callTool({
        name: "testforge_analyze",
        arguments: { root: allowed },
      });
      assert.equal(preferredAccepted.isError, undefined);
      assert.equal(legacyAccepted.isError, undefined);
      assert.deepEqual(preferredAccepted.structuredContent, legacyAccepted.structuredContent);

      const preferredRejected = await client.callTool({
        name: "assertledger_analyze",
        arguments: { root: forbidden },
      });
      assert.equal(preferredRejected.isError, true);
      assert.match(JSON.stringify(preferredRejected.content), /MCP_REPOSITORY_ROOT_FORBIDDEN/);
    } finally {
      await client.close();
    }
  });
});
