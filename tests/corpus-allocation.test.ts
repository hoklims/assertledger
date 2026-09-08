import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  agenticCorpusAllocationJsonSchema,
  agenticCorpusAllocationReplayResultJsonSchema,
  agenticCorpusAllocationRequestJsonSchema,
  parseAgenticCorpusAllocation,
  parseAgenticCorpusAllocationReplayResult,
  parseAgenticCorpusAllocationRequest,
} from "../src/contracts/index.js";
import {
  AGENTIC_CORPUS_ALLOCATION_ALGORITHM,
  agenticCorpusAllocationDigest,
  createAgenticCorpusAllocation,
  replayAgenticCorpusAllocation,
} from "../src/core/index.js";
import { runCli } from "../src/cli.js";
import { parseAgenticCorpusCase } from "../src/evaluation/agentic-corpus.js";
import { createTestForgeServer } from "../src/mcp/index.js";
import { TestForge } from "../src/sdk/index.js";

const SEED_DIGEST = "sha256:0000000000000000000000000000000000000000000000000000000000000001";
const CASE_IDS = [
  "synthetic-case-001",
  "synthetic-case-002",
  "synthetic-case-003",
  "synthetic-case-004",
  "synthetic-case-005",
  "synthetic-case-006",
  "synthetic-case-007",
  "synthetic-case-008",
];

function request(caseIds = CASE_IDS) {
  return {
    schemaVersion: "1.0.0" as const,
    allocationId: "synthetic-conformance-allocation-v1",
    seedDigest: SEED_DIGEST,
    strata: [
      {
        sourceId: "synthetic-source-a",
        sourceIdentityDigest: `sha256:${"1".repeat(64)}`,
        calibrationCount: 2,
        caseIds: caseIds.slice(0, 4),
      },
      {
        sourceId: "synthetic-source-b",
        sourceIdentityDigest: `sha256:${"2".repeat(64)}`,
        calibrationCount: 2,
        caseIds: caseIds.slice(4),
      },
    ],
  };
}

function independentScore(caseId: string): string {
  return `sha256:${createHash("sha256")
    .update(`TESTFORGE_CORPUS_ALLOCATION_V1\0${SEED_DIGEST}\0${caseId}`, "utf8")
    .digest("hex")}`;
}

describe("Agentic Corpus Allocation v1", () => {
  it("freezes an eight-case synthetic split under independently computed SHA-256 scores", () => {
    const allocation = createAgenticCorpusAllocation(
      parseAgenticCorpusAllocationRequest(request()),
    );

    assert.equal(allocation.algorithm, "SHA256_ASCENDING_SPLIT_V1");
    assert.equal(AGENTIC_CORPUS_ALLOCATION_ALGORITHM, "SHA256_ASCENDING_SPLIT_V1");
    assert.deepEqual(allocation.sourceCaseIds, [...CASE_IDS].sort());
    assert.deepEqual(allocation.calibrationCaseIds, [
      "synthetic-case-004",
      "synthetic-case-006",
      "synthetic-case-005",
      "synthetic-case-001",
    ]);
    assert.deepEqual(allocation.holdoutCaseIds, [
      "synthetic-case-007",
      "synthetic-case-008",
      "synthetic-case-003",
      "synthetic-case-002",
    ]);
    assert.deepEqual(
      allocation.assignments.map(({ caseId, scoreDigest }) => ({ caseId, scoreDigest })),
      allocation.assignments.map(({ caseId }) => ({
        caseId,
        scoreDigest: independentScore(caseId),
      })),
    );
    assert.equal(
      allocation.allocationDigest,
      "sha256:df683b14564ad584ae4a8b33380512f1ea0b2c2a96171c76b39b2517e6fa417e",
    );
    assert.equal(
      parseAgenticCorpusAllocation(allocation).allocationDigest,
      allocation.allocationDigest,
    );
    assert.equal(replayAgenticCorpusAllocation(allocation).valid, true);
  });

  it("is invariant to source case permutations", () => {
    const forward = createAgenticCorpusAllocation(parseAgenticCorpusAllocationRequest(request()));
    const reversed = request();
    reversed.strata = reversed.strata
      .map((stratum) => ({ ...stratum, caseIds: [...stratum.caseIds].reverse() }))
      .reverse();
    const reverse = createAgenticCorpusAllocation(parseAgenticCorpusAllocationRequest(reversed));
    assert.deepEqual(reverse, forward);
  });

  it("rejects invalid counts, duplicates, portable collisions, digests, and unknown fields", () => {
    for (const invalid of [
      { ...request(), strata: [{ ...request().strata[0], calibrationCount: 0 }] },
      { ...request(), strata: [{ ...request().strata[0], calibrationCount: 4 }] },
      {
        ...request(),
        strata: [
          {
            ...request().strata[0],
            caseIds: [...(request().strata[0]?.caseIds ?? []), "synthetic-case-005"],
          },
          request().strata[1],
        ],
      },
      {
        ...request(),
        strata: [{ ...request().strata[0], caseIds: ["Case-A", "case-a"] }],
      },
      { ...request(), seedDigest: `sha256:${"A".repeat(64)}` },
      { ...request(), unexpected: true },
    ]) {
      assert.throws(() => parseAgenticCorpusAllocationRequest(invalid));
    }
    const allocation = createAgenticCorpusAllocation(
      parseAgenticCorpusAllocationRequest(request()),
    );
    assert.throws(() => parseAgenticCorpusAllocation({ ...allocation, unexpected: true }));
  });

  it("rejects a re-digested forged partition", () => {
    const allocation = createAgenticCorpusAllocation(
      parseAgenticCorpusAllocationRequest(request()),
    );
    const forged = structuredClone(allocation);
    [forged.calibrationCaseIds[0], forged.holdoutCaseIds[0]] = [
      forged.holdoutCaseIds[0] as string,
      forged.calibrationCaseIds[0] as string,
    ];
    forged.allocationDigest = agenticCorpusAllocationDigest(forged);

    const replay = parseAgenticCorpusAllocationReplayResult(
      replayAgenticCorpusAllocation(parseAgenticCorpusAllocation(forged)),
    );
    assert.equal(replay.schemaValid, true);
    assert.equal(replay.allocationDigestValid, true);
    assert.equal(replay.partitionSemanticsValid, false);
    assert.equal(replay.valid, false);
    assert.deepEqual(replayAgenticCorpusAllocation({}), {
      valid: false,
      schemaValid: false,
      allocationDigestValid: false,
      sourceCaseIdsValid: false,
      assignmentScoresValid: false,
      partitionSemanticsValid: false,
    });
  });

  it("keeps legacy H1-H4 corpus case parsing unchanged", () => {
    const legacy = {
      schemaVersion: "1.0.0",
      caseId: "legacy-case",
      sourceId: "legacy-source",
      sourceRevision: `sha256:${"a".repeat(64)}`,
      h1: { equalTargetStrength: true, baselineWarmP95Us: 11, profileWarmP95Us: 7 },
      h2: {
        baselineNeutralSurvived: 1,
        baselineNeutralTotal: 2,
        profileNeutralSurvived: 2,
        profileNeutralTotal: 3,
      },
      h3: {
        equalBudget: true,
        baselineHeldOutFaultsDetected: 1,
        baselineHeldOutFaultsTotal: 2,
        profileHeldOutFaultsDetected: 2,
        profileHeldOutFaultsTotal: 3,
      },
      h4: {
        reviewedReduction: true,
        baselineHistoricalFaultsDetected: 1,
        baselineHistoricalFaultsTotal: 2,
        profileHistoricalFaultsDetected: 2,
        profileHistoricalFaultsTotal: 3,
        baselineCostUs: 11,
        profileCostUs: 7,
        baselineMutantCount: 5,
        profileMutantCount: 4,
      },
    };
    assert.deepEqual(parseAgenticCorpusCase(legacy), legacy);
  });

  it("publishes strict versioned schemas", () => {
    assert.deepEqual(
      [
        agenticCorpusAllocationRequestJsonSchema(),
        agenticCorpusAllocationJsonSchema(),
        agenticCorpusAllocationReplayResultJsonSchema(),
      ].map((schema) => schema.$id),
      [
        "https://testforge.dev/schemas/agentic-corpus-allocation-request.v1.json",
        "https://testforge.dev/schemas/agentic-corpus-allocation.v1.json",
        "https://testforge.dev/schemas/agentic-corpus-allocation-replay-result.v1.json",
      ],
    );
  });

  it("exposes equivalent deterministic SDK, CLI, and read-only MCP facades", async () => {
    const sdk = new TestForge();
    const allocation = sdk.allocateCorpus(request());
    assert.equal(sdk.replayCorpusAllocation(allocation).valid, true);

    const cliOutput: string[] = [];
    const cliIo = {
      cwd: process.cwd(),
      async readStdin() {
        return JSON.stringify(request());
      },
      writeStdout(text: string) {
        cliOutput.push(text);
      },
      writeStderr() {},
    };
    assert.equal(await runCli(["corpus-allocate", "-", "--json"], cliIo), 0);
    assert.deepEqual(JSON.parse(cliOutput.join("")), allocation);

    const server = createTestForgeServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "corpus-allocation-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const allocated = await client.callTool({
      name: "testforge_corpus_allocate",
      arguments: { request: request() },
    });
    assert.deepEqual(allocated.structuredContent, allocation);
    const replayed = await client.callTool({
      name: "testforge_corpus_allocation_replay",
      arguments: { allocation },
    });
    assert.equal((replayed.structuredContent as { valid: boolean }).valid, true);
    await client.close();
    await server.close();
  });
});
