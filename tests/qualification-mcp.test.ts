import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  exerciseQualificationHandlers,
  smokeQualificationPlan,
  smokeTestSource,
} from "../scripts/qualification-smoke.js";
import { sha256Canonical } from "../src/core/index.js";
import {
  qualificationFileDigest,
  qualificationMechanismDigest,
  qualificationRepositoryDigest,
} from "../src/engine/qualification.js";
import { createAssertLedgerServer } from "../src/mcp/index.js";
import { AssertLedger } from "../src/sdk/index.js";

test("MCP seals, executes and replays node:test qualification and refuses safe execution", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qualification-mcp-"));
  async function connect(allowUnsafeExecution: boolean) {
    const server = createAssertLedgerServer({
      allowedRepositoryRoots: [root],
      allowUnsafeExecution,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "qualification-handler-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }
  try {
    await writeFile(path.join(root, "public.test.mjs"), smokeTestSource);
    const plan = smokeQualificationPlan();
    plan.subject.inputDigest = await qualificationRepositoryDigest(root);
    plan.subject.candidateDigest = sha256Canonical([]);
    const nodeTool = plan.tools[0];
    assert.ok(nodeTool);
    nodeTool.digest = await qualificationFileDigest(process.execPath);
    const sealed = new AssertLedger().sealQualificationPlan(plan);
    const request = { root, ...sealed, candidate: { files: [] } };
    const safe = await connect(false);
    try {
      await assert.rejects(
        safe.callTool({ name: "assertledger_qualify", arguments: { request } }),
        /not found|unknown|not available/u,
      );
    } finally {
      await safe.close();
    }
    const executing = await connect(true);
    try {
      const receipt = await exerciseQualificationHandlers(executing, request);
      assert.equal(
        (receipt.provenance.runtime as Record<string, unknown>).mechanismDigest,
        await qualificationMechanismDigest(),
      );
      assert.equal(await readFile(path.join(root, "public.test.mjs"), "utf8"), smokeTestSource);
      const outside = await executing.callTool({
        name: "assertledger_qualify",
        arguments: { request: { ...request, root: os.tmpdir() } },
      });
      assert.equal(outside.isError, true);
      assert.match(JSON.stringify(outside), /MCP_REPOSITORY_ROOT_FORBIDDEN/u);
    } finally {
      await executing.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
