import assert from "node:assert/strict";
import { describe, it } from "node:test";

type ContractsApi = {
  SCHEMA_VERSION: string;
  agenticCorpusTrustPolicyJsonSchema(): Record<string, unknown>;
  agenticCorpusProvenanceJsonSchema(): Record<string, unknown>;
  agenticBenchmarkArtifactJsonSchema(): Record<string, unknown>;
  agenticBenchmarkReplayResultJsonSchema(): Record<string, unknown>;
  agenticBenchmarkRequestJsonSchema(): Record<string, unknown>;
  agenticProfileReplayResultJsonSchema(): Record<string, unknown>;
  agenticProfileReplayResultV2JsonSchema(): Record<string, unknown>;
  agenticProfileReportJsonSchema(): Record<string, unknown>;
  agenticProfileReportV2JsonSchema(): Record<string, unknown>;
  agenticProfileRequestJsonSchema(): Record<string, unknown>;
  agenticProfileRequestV2JsonSchema(): Record<string, unknown>;
  parseRepositoryAnalysis(value: unknown): any;
  parseEvidenceManifest(value: unknown): any;
  parseReplayResult(value: unknown): any;
  parseVerificationRequest(value: unknown): any;
  repositoryAnalysisJsonSchema(): Record<string, unknown>;
  evidenceManifestJsonSchema(): Record<string, unknown>;
  replayResultJsonSchema(): Record<string, unknown>;
  verificationRequestJsonSchema(): Record<string, unknown>;
};

async function loadContracts(): Promise<ContractsApi> {
  try {
    return (await import("../src/contracts/index.js")) as ContractsApi;
  } catch {
    return {
      SCHEMA_VERSION: "UNIMPLEMENTED",
      agenticCorpusTrustPolicyJsonSchema: () => ({}),
      agenticCorpusProvenanceJsonSchema: () => ({}),
      agenticBenchmarkArtifactJsonSchema: () => ({}),
      agenticBenchmarkReplayResultJsonSchema: () => ({}),
      agenticBenchmarkRequestJsonSchema: () => ({}),
      agenticProfileReplayResultJsonSchema: () => ({}),
      agenticProfileReplayResultV2JsonSchema: () => ({}),
      agenticProfileReportJsonSchema: () => ({}),
      agenticProfileReportV2JsonSchema: () => ({}),
      agenticProfileRequestJsonSchema: () => ({}),
      agenticProfileRequestV2JsonSchema: () => ({}),
      parseRepositoryAnalysis: () => undefined,
      parseEvidenceManifest: () => undefined,
      parseReplayResult: () => undefined,
      parseVerificationRequest: () => ({ schemaVersion: "UNIMPLEMENTED" }),
      repositoryAnalysisJsonSchema: () => ({}),
      evidenceManifestJsonSchema: () => ({}),
      replayResultJsonSchema: () => ({}),
      verificationRequestJsonSchema: () => ({}),
    };
  }
}

function validRepositoryAnalysis() {
  return {
    root: "C:\\project",
    fileCount: 2,
    files: ["package.json", "src/index.ts"],
    languages: [{ name: "TypeScript", files: 1 }],
    detectedTestFrameworks: ["node:test"],
    repositoryDigest: `sha256:${"a".repeat(64)}`,
    capabilities: {
      canExecuteCandidates: true,
      supportedAdapters: ["node-test", "testforge-command"],
      isolationLevels: ["UNSANDBOXED"],
    },
  };
}

function validEvidenceManifest(): any {
  const digest = (character: string) => `sha256:${character.repeat(64)}`;
  return {
    schemaVersion: "1.0.0",
    repositoryDigest: digest("a"),
    evidenceContext: {
      engine: { name: "testforge", version: "0.1.0" },
      adapter: {
        name: "node-test",
        version: "24.0.0",
        configuration: {
          kind: "node-test",
          executable: "node",
          baseTestFiles: ["tests/base.test.js"],
        },
      },
      execution: {
        isolation: "UNSANDBOXED",
        environmentAllowlist: ["PATH"],
        budgets: { maximumExecutions: 8 },
        candidateRoots: ["tests/candidates"],
      },
      worlds: [
        { id: "reference", provenance: "git:abc", digest: digest("b") },
        { id: "target", provenance: "issue:123", digest: digest("c") },
        { id: "neutral", provenance: "review:1", digest: digest("d") },
      ],
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 1,
      minimumTargetWeightPermille: 1_000,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds: [
      { id: "reference", kind: "REFERENCE", required: true, weight: 0 },
      { id: "target", kind: "TARGET", required: true, weight: 1 },
      { id: "neutral", kind: "NEUTRAL", required: true, weight: 0 },
    ],
    candidates: [
      {
        id: "candidate",
        digest: digest("e"),
        sizeBytes: 123,
        status: "ELIGIBLE",
        killedTargetIds: ["target"],
        targetWeightKilled: 1,
        gates: [
          {
            name: "TARGET_STRENGTH",
            status: "PASSED",
            evidenceRunIds: ["candidate:target:1"],
            reasonCodes: [],
          },
        ],
        reasonCodes: ["POLICY_SATISFIED"],
      },
    ],
    observations: [
      {
        runId: "candidate:target:1",
        candidateId: "candidate",
        worldId: "target",
        attempt: 1,
        outcome: "ASSERTION_FAILURE",
        testsDiscovered: 1,
        candidateTestsDiscovered: 1,
        attributed: true,
        durationMs: 12,
        exitCode: 1,
        stdoutDigest: digest("f"),
        stderrDigest: digest("0"),
      },
    ],
    decision: {
      status: "VERIFIED",
      selectedCandidateIds: ["candidate"],
      reasonCodes: ["POLICY_SATISFIED"],
    },
    decisionDigest: digest("1"),
    artifactDigest: digest("2"),
    adapter: { kind: "node-test" },
    isolation: {
      kind: "trusted-local",
      level: "UNSANDBOXED",
      acknowledgedUnsafeExecution: true,
    },
    limitations: ["UNSANDBOXED trusted-local execution."],
  };
}

function findPropertySchema(value: unknown, property: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.properties === "object" && record.properties !== null) {
    const match = (record.properties as Record<string, unknown>)[property];
    if (typeof match === "object" && match !== null) return match as Record<string, unknown>;
  }
  for (const nested of Object.values(record)) {
    const match = findPropertySchema(nested, property);
    if (match !== undefined) return match;
  }
  return undefined;
}

const contracts = await loadContracts();

function validRequest() {
  return {
    schemaVersion: "1.0.0",
    repository: { root: ".", exclude: [".git", "node_modules"] },
    adapter: {
      kind: "node-test",
      executable: "node",
      baseTestFiles: ["tests/base.test.js"],
    },
    isolation: {
      kind: "trusted-local",
      acknowledgedUnsafeExecution: true,
      environmentAllowlist: ["PATH"],
    },
    candidateRoots: ["tests/candidates"],
    budgets: {
      maximumCandidates: 4,
      maximumWorlds: 4,
      maximumExecutions: 32,
      maximumRepositoryFiles: 10_000,
      maximumRepositoryBytes: 100_000_000,
      maximumWorldOverlayBytes: 1_000_000,
      maximumCandidateBytes: 16_384,
      maximumTotalCandidateBytes: 65_536,
      timeoutMsPerExecution: 5_000,
      maximumOutputBytes: 65_536,
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 2,
      minimumTargetWeightPermille: 1_000,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds: [
      {
        id: "reference",
        kind: "REFERENCE",
        required: true,
        weight: 0,
        provenance: "git:abc",
        files: [],
      },
      {
        id: "target",
        kind: "TARGET",
        required: true,
        weight: 1,
        provenance: "issue:123",
        files: [{ path: "src/value.js", content: "export const value = 0;\n" }],
      },
      {
        id: "neutral",
        kind: "NEUTRAL",
        required: true,
        weight: 0,
        provenance: "equivalence-review:1",
        files: [],
      },
    ],
    candidates: [
      {
        id: "candidate",
        files: [{ path: "tests/candidates/value.test.js", content: "// candidate\n" }],
      },
    ],
  };
}

describe("verification request contract", () => {
  it("accepts a complete versioned campaign", () => {
    const parsed = contracts.parseVerificationRequest(validRequest());

    assert.equal(parsed.schemaVersion, "1.0.0");
    assert.equal(parsed.worlds.length, 3);
  });

  it("rejects unknown major versions and duplicate identifiers", () => {
    const version = validRequest();
    version.schemaVersion = "2.0.0";
    assert.throws(() => contracts.parseVerificationRequest(version), /SCHEMA_VERSION_UNSUPPORTED/);

    const duplicates = validRequest();
    const duplicateWorld = duplicates.worlds[1];
    assert.ok(duplicateWorld);
    duplicateWorld.id = "reference";
    assert.throws(() => contracts.parseVerificationRequest(duplicates), /DUPLICATE_WORLD_ID/);
  });

  it("requires reference, target, and neutral evidence worlds", () => {
    const missingNeutral = validRequest();
    missingNeutral.worlds = missingNeutral.worlds.filter((world) => world.kind !== "NEUTRAL");

    assert.throws(
      () => contracts.parseVerificationRequest(missingNeutral),
      /NEUTRAL_WORLD_REQUIRED/,
    );
  });

  it("rejects plans whose deterministic execution count exceeds budget", () => {
    const overBudget = validRequest();
    overBudget.budgets.maximumExecutions = 11;

    assert.throws(
      () => contracts.parseVerificationRequest(overBudget),
      /EXECUTION_BUDGET_EXCEEDED/,
    );
  });

  it("rejects target outcome policies that would count infrastructure errors as proof", () => {
    const unsafe = validRequest();
    unsafe.policy.acceptedTargetOutcomes = ["TIMEOUT"];

    assert.throws(() => contracts.parseVerificationRequest(unsafe), /UNSAFE_TARGET_OUTCOME/);
  });

  it("requires the target-outcome policy to be the exact singleton assertion outcome", () => {
    const duplicated = validRequest();
    duplicated.policy.acceptedTargetOutcomes = ["ASSERTION_FAILURE", "ASSERTION_FAILURE"];

    assert.throws(() => contracts.parseVerificationRequest(duplicated), /REQUEST_SCHEMA_INVALID/);
  });

  it("rejects every non-empty node:test extra argument", () => {
    for (const argument of [
      "--test-reporter=spec",
      "--test-only",
      "--test-shard=1/2",
      "--experimental-test-isolation=none",
      "--import=hook.mjs",
      "--require=hook.cjs",
      "--loader=hook.mjs",
      "--env-file=.env",
      "--test-concurrency=2",
      "tests/extra.test.js",
    ]) {
      const unsafe = validRequest();
      (unsafe.adapter as { extraArguments?: string[] }).extraArguments = [argument];

      assert.throws(() => contracts.parseVerificationRequest(unsafe), /UNSAFE_NODE_TEST_ARGUMENT/);
    }
  });

  it("keeps an explicitly empty node:test extra argument list compatible", () => {
    const request = validRequest();
    (request.adapter as { extraArguments?: string[] }).extraArguments = [];

    assert.deepEqual(contracts.parseVerificationRequest(request).adapter.extraArguments, []);
  });

  it("rejects campaigns whose aggregate world overlays exceed their byte budget", () => {
    const overBudget = validRequest();
    overBudget.budgets.maximumWorldOverlayBytes = 10;

    assert.throws(
      () => contracts.parseVerificationRequest(overBudget),
      /WORLD_OVERLAY_BYTES_EXCEEDED/,
    );
  });

  it("rejects campaigns whose candidates collectively exceed their byte budget", () => {
    const overBudget = validRequest();
    overBudget.candidates.push({
      id: "candidate-two",
      files: [{ path: "tests/candidates/two.test.js", content: "éééé\n" }],
    });
    overBudget.budgets.maximumTotalCandidateBytes = 20;

    assert.throws(
      () => contracts.parseVerificationRequest(overBudget),
      /TOTAL_CANDIDATE_BYTES_EXCEEDED/,
    );
  });

  it("rejects reserved environment variables case-insensitively", () => {
    for (const variable of [
      "NODE_OPTIONS",
      "node_options",
      "TESTFORGE_RESULT_FILE",
      "testforge_candidate_files",
      "NODE_TEST_CONTEXT",
      "node_test_reporter",
    ]) {
      const unsafe = validRequest();
      unsafe.isolation.environmentAllowlist = ["PATH", variable];

      assert.throws(
        () => contracts.parseVerificationRequest(unsafe),
        /RESERVED_ENVIRONMENT_VARIABLE/,
      );
    }
  });
});

describe("published JSON Schema", () => {
  it("emits a strict Draft 2020-12 schema with a stable identifier", () => {
    const schema = contracts.verificationRequestJsonSchema();

    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.$id, "https://testforge.dev/schemas/verification-request.v1.json");
    assert.equal(schema.additionalProperties, false);
    const serialized = JSON.stringify(schema);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const definitions = schema.$defs as Record<string, Record<string, unknown>>;
    const versionReference = properties.schemaVersion?.$ref;
    assert.equal(typeof versionReference, "string");
    const versionDefinition = definitions[String(versionReference).replace("#/$defs/", "")];
    assert.equal(versionDefinition?.const, "1.0.0");
    assert.doesNotMatch(serialized, /"TIMEOUT"/);
    const extraArguments = findPropertySchema(schema, "extraArguments");
    assert.equal(extraArguments?.maxItems, 0);
    assert.equal(serialized.includes("[Tt][Ee][Ss][Tt][Ff][Oo][Rr][Gg][Ee]_"), true);
    const targetOutcomes = findPropertySchema(schema, "acceptedTargetOutcomes");
    assert.equal(targetOutcomes?.minItems, 1);
    assert.equal(targetOutcomes?.maxItems, 1);
  });

  it("publishes every public result contract under a stable versioned identifier", () => {
    const schemas = [
      [
        contracts.agenticCorpusTrustPolicyJsonSchema(),
        "https://testforge.dev/schemas/agentic-corpus-trust-policy.v1.json",
      ],
      [
        contracts.agenticCorpusProvenanceJsonSchema(),
        "https://testforge.dev/schemas/agentic-corpus-provenance.v1.json",
      ],
      [
        contracts.agenticBenchmarkRequestJsonSchema(),
        "https://testforge.dev/schemas/agentic-benchmark-request.v1.json",
      ],
      [
        contracts.agenticBenchmarkArtifactJsonSchema(),
        "https://testforge.dev/schemas/agentic-benchmark-artifact.v1.json",
      ],
      [
        contracts.agenticBenchmarkReplayResultJsonSchema(),
        "https://testforge.dev/schemas/agentic-benchmark-replay-result.v1.json",
      ],
      [
        contracts.repositoryAnalysisJsonSchema(),
        "https://testforge.dev/schemas/repository-analysis.v1.json",
      ],
      [
        contracts.evidenceManifestJsonSchema(),
        "https://testforge.dev/schemas/evidence-manifest.v1.json",
      ],
      [contracts.replayResultJsonSchema(), "https://testforge.dev/schemas/replay-result.v1.json"],
      [
        contracts.agenticProfileRequestJsonSchema(),
        "https://testforge.dev/schemas/agentic-profile-request.v1.json",
      ],
      [
        contracts.agenticProfileReportJsonSchema(),
        "https://testforge.dev/schemas/agentic-profile-report.v1.json",
      ],
      [
        contracts.agenticProfileReplayResultJsonSchema(),
        "https://testforge.dev/schemas/agentic-profile-replay-result.v1.json",
      ],
      [
        contracts.agenticProfileRequestV2JsonSchema(),
        "https://testforge.dev/schemas/agentic-profile-request.v2.json",
      ],
      [
        contracts.agenticProfileReportV2JsonSchema(),
        "https://testforge.dev/schemas/agentic-profile-report.v2.json",
      ],
      [
        contracts.agenticProfileReplayResultV2JsonSchema(),
        "https://testforge.dev/schemas/agentic-profile-replay-result.v2.json",
      ],
    ] as const;

    for (const [schema, id] of schemas) {
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.equal(schema.$id, id);
      assert.equal(schema.additionalProperties, false);
    }
  });
});

describe("repository analysis contract", () => {
  it("accepts the exact deterministic repository analysis shape", () => {
    const parsed = contracts.parseRepositoryAnalysis(validRepositoryAnalysis());

    assert.equal(parsed.fileCount, 2);
    assert.deepEqual(parsed.capabilities.supportedAdapters, ["node-test", "testforge-command"]);
  });

  it("rejects analysis metadata that disagrees with the published file list", () => {
    const analysis = validRepositoryAnalysis();
    analysis.fileCount = 3;

    assert.throws(
      () => contracts.parseRepositoryAnalysis(analysis),
      /REPOSITORY_ANALYSIS_INCONSISTENT/,
    );
  });
});

describe("evidence manifest contract", () => {
  it("accepts a final engine manifest including auditable gates and observations", () => {
    const parsed = contracts.parseEvidenceManifest(validEvidenceManifest());

    assert.equal(parsed.decision.status, "VERIFIED");
    assert.equal(parsed.candidates[0].gates[0].name, "TARGET_STRENGTH");
    assert.equal(parsed.observations[0].stdoutDigest, `sha256:${"f".repeat(64)}`);
  });

  it("keeps legacy node-test manifests without official profile metadata compatible", () => {
    const legacyManifest = validEvidenceManifest();
    assert.equal("profile" in legacyManifest.evidenceContext.adapter.configuration, false);

    const parsed = contracts.parseEvidenceManifest(legacyManifest);

    assert.equal(parsed.decision.status, "VERIFIED");
    assert.equal(parsed.adapter.kind, "node-test");
  });

  it("rejects unknown final-manifest fields", () => {
    const manifest = { ...validEvidenceManifest(), unsealedClaim: true };

    assert.throws(() => contracts.parseEvidenceManifest(manifest), /EVIDENCE_MANIFEST_INVALID/);
  });

  it("accepts the deterministic ENGINE_ERROR manifest emitted for invalid evidence", () => {
    const manifest = validEvidenceManifest();
    manifest.repositoryDigest = "invalid";
    manifest.evidenceContext = {
      engine: { name: "invalid", version: "invalid" },
      adapter: { name: "invalid", version: "invalid", configuration: {} },
      execution: {
        isolation: "invalid",
        environmentAllowlist: [],
        budgets: {},
        candidateRoots: [],
      },
      worlds: [],
    };
    manifest.policy = {
      policyVersion: "invalid",
      requiredAttempts: 1,
      minimumTargetWeightPermille: 1_000,
      maximumSelectedCandidates: 0,
      acceptedTargetOutcomes: [],
    } as any;
    manifest.worlds = [];
    manifest.candidates = [];
    manifest.observations = [];
    manifest.decision = {
      status: "ENGINE_ERROR",
      selectedCandidateIds: [],
      reasonCodes: ["EVIDENCE_INPUT_INVALID"],
    };

    assert.equal(contracts.parseEvidenceManifest(manifest).decision.status, "ENGINE_ERROR");
  });

  it("rejects dangling candidate, world, and run references", () => {
    const selected = validEvidenceManifest();
    selected.decision.selectedCandidateIds = ["missing"];
    assert.throws(
      () => contracts.parseEvidenceManifest(selected),
      /EVIDENCE_MANIFEST_INCONSISTENT/,
    );

    const observation = validEvidenceManifest();
    observation.observations[0].worldId = "missing";
    assert.throws(
      () => contracts.parseEvidenceManifest(observation),
      /EVIDENCE_MANIFEST_INCONSISTENT/,
    );

    const gate = validEvidenceManifest();
    gate.candidates[0].gates[0].evidenceRunIds = ["missing"];
    assert.throws(() => contracts.parseEvidenceManifest(gate), /EVIDENCE_MANIFEST_INCONSISTENT/);
  });

  it("rejects candidate discovery counts greater than total discovered tests", () => {
    const manifest = validEvidenceManifest();
    manifest.observations[0].candidateTestsDiscovered = 2;

    assert.throws(
      () => contracts.parseEvidenceManifest(manifest),
      /EVIDENCE_MANIFEST_INCONSISTENT/,
    );
  });

  it("rejects negative process exit codes while retaining null for signalled processes", () => {
    const negative = validEvidenceManifest();
    negative.observations[0].exitCode = -1;
    assert.throws(() => contracts.parseEvidenceManifest(negative), /EVIDENCE_MANIFEST_INVALID/);

    const signalled = validEvidenceManifest();
    signalled.observations[0].exitCode = null;
    assert.equal(contracts.parseEvidenceManifest(signalled).observations[0].exitCode, null);
  });

  it("rejects contradictory public adapter summaries", () => {
    const kindMismatch = validEvidenceManifest();
    kindMismatch.adapter = { kind: "testforge-command", protocolVersion: "1.0.0" };
    assert.throws(
      () => contracts.parseEvidenceManifest(kindMismatch),
      /EVIDENCE_MANIFEST_INCONSISTENT/,
    );

    const configurationMismatch = validEvidenceManifest();
    configurationMismatch.evidenceContext.adapter.configuration.kind = "testforge-command";
    assert.throws(
      () => contracts.parseEvidenceManifest(configurationMismatch),
      /EVIDENCE_MANIFEST_INCONSISTENT/,
    );

    const protocolMismatch = validEvidenceManifest();
    protocolMismatch.adapter = { kind: "testforge-command", protocolVersion: "1.0.0" };
    protocolMismatch.evidenceContext.adapter.name = "testforge-command";
    protocolMismatch.evidenceContext.adapter.configuration = {
      kind: "testforge-command",
      executable: "node",
      arguments: ["reporter.mjs"],
      protocolVersion: "1.0.0",
    };
    protocolMismatch.evidenceContext.adapter.version = "2.0.0";
    assert.throws(
      () => contracts.parseEvidenceManifest(protocolMismatch),
      /EVIDENCE_MANIFEST_INCONSISTENT/,
    );
  });

  it("rejects a public isolation summary that contradicts its evidence context", () => {
    const manifest = validEvidenceManifest();
    manifest.evidenceContext.execution.isolation = "CONTAINER";

    assert.throws(
      () => contracts.parseEvidenceManifest(manifest),
      /EVIDENCE_MANIFEST_INCONSISTENT/,
    );
  });

  it("rejects invalid sentinels on a decision-bearing manifest", () => {
    const manifest = validEvidenceManifest();
    manifest.repositoryDigest = "invalid";

    assert.throws(
      () => contracts.parseEvidenceManifest(manifest),
      /EVIDENCE_MANIFEST_INCONSISTENT/,
    );
  });
});

async function sealedReplayFixture(): Promise<any> {
  const core = await import("../src/core/index.js");
  const fixture = validEvidenceManifest();
  const manifest = core.decideEvidence({
    schemaVersion: fixture.schemaVersion,
    repositoryDigest: fixture.repositoryDigest,
    evidenceContext: fixture.evidenceContext,
    policy: fixture.policy,
    worlds: fixture.worlds,
    candidates: fixture.candidates.map(({ id, digest, sizeBytes }: any) => ({
      id,
      digest,
      sizeBytes,
    })),
    observations: fixture.observations,
  });
  return core.sealManifestArtifact({
    ...manifest,
    adapter: fixture.adapter,
    isolation: fixture.isolation,
    limitations: fixture.limitations,
  });
}

describe("schema-gated replay", () => {
  it("rejects a re-sealed adapter-summary substitution despite valid public digests", async () => {
    const core = await import("../src/core/index.js");
    const { TestForge } = await import("../src/sdk/index.js");
    const manifest = await sealedReplayFixture();
    const forged = core.sealManifestArtifact({
      ...manifest,
      adapter: { kind: "testforge-command", protocolVersion: "1.0.0" },
    });

    assert.equal(core.verifyManifestIntegrity(forged).valid, true);
    assert.equal(new TestForge().replay(forged).schemaValid, false);
    assert.equal(new TestForge().replay(forged).valid, false);
  });

  it("rejects re-sealed contradictory isolation despite valid public digests", async () => {
    const core = await import("../src/core/index.js");
    const { TestForge } = await import("../src/sdk/index.js");
    const manifest = await sealedReplayFixture();
    manifest.evidenceContext.execution.isolation = "CONTAINER";
    manifest.decisionDigest = core.sha256Canonical({
      schemaVersion: manifest.schemaVersion,
      repositoryDigest: manifest.repositoryDigest,
      evidenceContext: manifest.evidenceContext,
      policy: manifest.policy,
      worlds: manifest.worlds,
      candidates: manifest.candidates,
      observations: manifest.observations.map(
        ({
          durationMs: _,
          exitCode: _exit,
          stdoutDigest: _stdout,
          stderrDigest: _stderr,
          ...run
        }: any) => run,
      ),
      decision: manifest.decision,
    });
    const forged = core.sealManifestArtifact(manifest);

    assert.equal(core.verifyManifestIntegrity(forged).valid, true);
    assert.equal(new TestForge().replay(forged).schemaValid, false);
    assert.equal(new TestForge().replay(forged).valid, false);
  });
});

describe("replay result contract", () => {
  it("accepts the semantic replay verdict and rejects incomplete results", () => {
    assert.deepEqual(
      contracts.parseReplayResult({
        valid: true,
        schemaValid: true,
        decisionDigestValid: true,
        artifactDigestValid: true,
        decisionSemanticsValid: true,
      }),
      {
        valid: true,
        schemaValid: true,
        decisionDigestValid: true,
        artifactDigestValid: true,
        decisionSemanticsValid: true,
      },
    );
    assert.throws(
      () =>
        contracts.parseReplayResult({
          valid: false,
          schemaValid: true,
          decisionDigestValid: true,
          artifactDigestValid: false,
        }),
      /REPLAY_RESULT_INVALID/,
    );
  });

  it("rejects a global replay verdict that contradicts its validation rails", () => {
    assert.throws(
      () =>
        contracts.parseReplayResult({
          valid: true,
          schemaValid: true,
          decisionDigestValid: true,
          artifactDigestValid: false,
          decisionSemanticsValid: true,
        }),
      /REPLAY_RESULT_INCONSISTENT/,
    );
  });
});
