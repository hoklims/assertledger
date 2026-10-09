import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/client";
import type {
  QualificationExecutionRequest,
  QualificationPlan,
  QualificationReceipt,
} from "../src/contracts/qualification.js";

export const smokeTestSource =
  'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("public qualification", () => assert.equal(1, 1));\n';

export function smokeQualificationPlan(): QualificationPlan {
  const pendingDigest = `sha256:${"0".repeat(64)}`;
  return {
    schemaVersion: "1.0.0",
    profileId: "public-package-node-test-v1",
    subject: {
      commit: "public-smoke-commit",
      baseCommit: "public-smoke-base",
      candidateDigest: pendingDigest,
      inputDigest: pendingDigest,
    },
    tools: [{ id: "node", version: process.versions.node, digest: pendingDigest }],
    suites: [{ id: "public", files: ["public.test.mjs"], extraction: "COMPLETE" }],
    obligations: [
      {
        id: "tests",
        kind: "tests",
        required: true,
        suiteIds: ["public"],
        checks: [{ id: "outcome", actionId: "test", field: "testOutcome", expected: "PASS" }],
        limits: [],
      },
    ],
    actions: [
      {
        id: "test",
        adapter: "node-test",
        executable: process.execPath,
        arguments: ["public.test.mjs"],
        environment: {},
        prepareFiles: [],
        removePaths: [],
        observe: { trace: false, outputs: [], report: null },
      },
    ],
    allowedCandidatePaths: ["public.test.mjs"],
    worlds: [
      { id: "reference", kind: "REFERENCE", files: [], discriminants: [] },
      {
        id: "assertion-fault",
        kind: "TARGET",
        files: [
          {
            path: "public.test.mjs",
            content: smokeTestSource.replace("equal(1, 1)", "equal(1, 2)"),
          },
        ],
        discriminants: [{ obligationId: "tests", checkIds: ["outcome"] }],
      },
      {
        id: "neutral",
        kind: "NEUTRAL",
        files: [{ path: "public.test.mjs", content: `// neutral comment\n${smokeTestSource}` }],
        discriminants: [],
      },
    ],
    requiredAttempts: 2,
    timeoutMs: 5000,
    maximumOutputBytes: 65536,
    isolation: { kind: "trusted-local", acknowledgedUnsafeExecution: true },
  };
}

/** Call handlers, rather than infer their behavior from registered names. */
export async function exerciseQualificationHandlers(
  client: Client,
  request: QualificationExecutionRequest,
): Promise<QualificationReceipt> {
  async function call(name: string, arguments_: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: arguments_ });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(result.structuredContent, `MCP_STRUCTURED_RESULT_MISSING:${name}`);
    return result.structuredContent as Record<string, unknown>;
  }
  const sealed = await call("assertledger_qualification_plan", { plan: request.plan });
  assert.equal(sealed.planDigest, request.planDigest);
  assert.deepEqual(sealed.plan, request.plan);
  const receipt = (await call("assertledger_qualify", {
    request,
  })) as unknown as QualificationReceipt;
  assert.equal(receipt.decision, "QUALIFIED");
  assert.equal(receipt.observations.length, 6);
  assert.ok(receipt.observations.every((observation) => observation.state === "COMPLETED"));
  const replay = await call("assertledger_qualification_replay", { receipt });
  assert.equal(replay.valid, true);
  assert.equal(replay.reexecuted, false);
  const forged = structuredClone(receipt);
  const first = forged.observations[0];
  assert.ok(first);
  first.facts.testOutcome = "ASSERTION_FAILURE";
  const refused = await call("assertledger_qualification_replay", { receipt: forged });
  assert.equal(refused.valid, false, "MCP_FORGED_RECEIPT_ACCEPTED");
  return receipt;
}
