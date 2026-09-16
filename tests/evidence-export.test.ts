import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import * as buildInfo from "../src/build-info.js";
import * as contracts from "../src/contracts/index.js";
import * as core from "../src/core/index.js";
import * as sdk from "../src/sdk/index.js";

type Outcome =
  | "PASS"
  | "ASSERTION_FAILURE"
  | "COLLECTION_FAILURE"
  | "COMPILE_FAILURE"
  | "PROCESS_CRASH"
  | "TIMEOUT"
  | "INFRA_ERROR"
  | "NO_TEST_DISCOVERED";

interface FixtureOptions {
  targetOutcome?: Outcome;
  invalidControls?: boolean;
  git?: "ALL" | "PARTIAL" | "NONE";
  nodeTestProfile?: boolean;
  durations?: boolean;
}

const OPERATIONAL_OUTCOMES: Outcome[] = [
  "COLLECTION_FAILURE",
  "COMPILE_FAILURE",
  "PROCESS_CRASH",
  "TIMEOUT",
  "INFRA_ERROR",
  "NO_TEST_DISCOVERED",
];

function digest(label: string): string {
  return core.sha256Canonical({ label });
}

function gitProvenance(role: "reference" | "target" | "neutral", character: string): string {
  return core.canonicalize({
    format: "assertledger-git-regression/1",
    role,
    commit: character.repeat(40),
    tree: character.toUpperCase() === character ? "f".repeat(40) : "e".repeat(40),
    objectFormat: "sha1",
    projection: "SELECTED_TEST_REMOVED_FOR_CONTROLS",
    reason: `${role} fixture revision`,
  });
}

function manifestFixture(options: FixtureOptions = {}) {
  const targetOutcome = options.targetOutcome ?? "ASSERTION_FAILURE";
  const worlds = [
    { id: "reference", kind: "REFERENCE", required: true, weight: 0 },
    { id: "target", kind: "TARGET", required: true, weight: 10 },
    { id: "neutral", kind: "NEUTRAL", required: true, weight: 0 },
  ] as const;
  const roles = { reference: "reference", target: "target", neutral: "neutral" } as const;
  const observations = worlds.flatMap((world) =>
    [1, 2, 3].flatMap((attempt) => [
      {
        runId: `control:${world.id}:${attempt}`,
        candidateId: null,
        worldId: world.id,
        attempt,
        outcome: options.invalidControls && world.kind === "NEUTRAL" ? "ASSERTION_FAILURE" : "PASS",
        testsDiscovered: 1,
        candidateTestsDiscovered: 0,
        attributed: false,
        ...(options.durations === false ? {} : { durationMs: 5 }),
      },
      {
        runId: `candidate:${world.id}:${attempt}`,
        candidateId: "candidate",
        worldId: world.id,
        attempt,
        outcome: world.kind === "TARGET" ? targetOutcome : "PASS",
        testsDiscovered: 2,
        candidateTestsDiscovered:
          world.kind === "TARGET" && targetOutcome === "NO_TEST_DISCOVERED" ? 0 : 1,
        attributed: !(world.kind === "TARGET" && targetOutcome === "NO_TEST_DISCOVERED"),
        ...(options.durations === false ? {} : { durationMs: 20 }),
      },
    ]),
  );
  const decided = core.decideEvidence({
    schemaVersion: "1.0.0",
    repositoryDigest: digest("repository"),
    evidenceContext: {
      engine: { name: "testforge", version: "0.1.0" },
      adapter: {
        name: "node-test",
        version: "22.15.0",
        configuration: options.nodeTestProfile
          ? {
              kind: "node-test",
              profile: {
                profileId: "node-test",
                profileVersion: "1.0.0",
                official: true,
                capabilities: {
                  detectsCollectionFailure: false,
                  detectsCompileFailure: false,
                  attributesPerAssertionFailure: true,
                },
                reporterDigest: digest("reporter"),
              },
              requestedExecutable: "node",
              resolvedExecutable: "/usr/bin/node",
              executableDigest: digest("node-executable"),
              nodeVersion: "v22.15.0",
              runtimePreflight: null,
              arguments: ["--test", "--", "tests/base.test.js"],
            }
          : { kind: "node-test", executable: "node" },
      },
      execution: {
        isolation: "UNSANDBOXED",
        environmentAllowlist: ["CI"],
        budgets: {},
        candidateRoots: ["tests"],
      },
      worlds: worlds.map((world, index) => ({
        id: world.id,
        provenance:
          options.git === "ALL" || (options.git === "PARTIAL" && index > 0)
            ? gitProvenance(roles[world.id], ["a", "b", "c"][index] as string)
            : `fixture:${world.id}`,
        digest: digest(world.id),
      })),
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 3,
      minimumTargetWeightPermille: 1_000,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds,
    candidates: [{ id: "candidate", digest: digest("candidate"), sizeBytes: 100 }],
    observations,
  });
  return contracts.parseEvidenceManifest(
    core.sealManifestArtifact({
      ...decided,
      adapter: { kind: "node-test" as const },
      isolation: {
        kind: "trusted-local" as const,
        level: "UNSANDBOXED" as const,
        acknowledgedUnsafeExecution: true as const,
      },
      limitations: ["UNSANDBOXED fixture."],
    }),
  );
}

function decisionDigestProjection(manifest: ReturnType<typeof manifestFixture>) {
  return {
    schemaVersion: manifest.schemaVersion,
    repositoryDigest: manifest.repositoryDigest,
    evidenceContext: manifest.evidenceContext,
    policy: manifest.policy,
    worlds: manifest.worlds,
    candidates: manifest.candidates,
    observations: manifest.observations.map(
      ({
        durationMs: _durationMs,
        exitCode: _exitCode,
        stdoutDigest: _stdoutDigest,
        stderrDigest: _stderrDigest,
        ...observation
      }) => observation,
    ),
    decision: manifest.decision,
  };
}

function exportRequest(
  manifest: unknown = manifestFixture(),
  consumerRequest: Record<string, unknown> | null = null,
) {
  return { schemaVersion: "1.0.0", manifest, consumerRequest };
}

function exportOf(manifest: unknown = manifestFixture(), consumerRequest = null) {
  return core.createEvidenceExport(
    contracts.parseEvidenceExportRequest(exportRequest(manifest, consumerRequest)),
  );
}

function withoutDigest<T extends { exportDigest: string }>(value: T): Omit<T, "exportDigest"> {
  const { exportDigest: _exportDigest, ...projection } = value;
  return projection;
}

function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reversedKeys(item)]),
  );
}

describe("evidence provider manifest", () => {
  it("describes version, source revision, capabilities, scope, cost, limits and formats", () => {
    const provider = core.createEvidenceProviderManifest({
      version: "1.0.0",
      sourceRevision: { status: "UNKNOWN" },
      adapters: [
        { kind: "node-test", profileId: "node-test", profileVersion: "1.0.0", official: true },
        { kind: "testforge-command", profileId: null, profileVersion: null, official: false },
      ],
    });

    assert.deepEqual(contracts.parseEvidenceProviderManifest(provider), provider);
    assert.deepEqual(provider.provider, {
      name: "assertledger",
      version: "1.0.0",
      sourceRevision: { status: "UNKNOWN" },
    });
    const capability = (id: string) => provider.capabilities.find((item) => item.id === id);
    assert.deepEqual(
      [capability("REGRESSION_DETECTION")?.status, capability("REGRESSION_DETECTION")?.modality],
      ["SUPPORTED", "TEST_OBSERVED"],
    );
    assert.equal(capability("GIT_REVISION_PROVENANCE")?.status, "SUPPORTED_WHEN_RECORDED");
    for (const id of ["PRODUCER_AUTHENTICATION", "SANDBOXED_EXECUTION", "EXECUTION_FRESHNESS"]) {
      assert.equal(capability(id)?.status, "UNSUPPORTED", id);
    }
    assert.ok(provider.scope.length > 0);
    assert.deepEqual(
      provider.formats.emits.map((format) => format.schemaId),
      [
        "https://testforge.dev/schemas/evidence-export.v1.json",
        "https://testforge.dev/schemas/evidence-export-replay-result.v1.json",
      ],
    );
    assert.ok(
      provider.formats.accepts.some(
        (format) => format.schemaId === "https://testforge.dev/schemas/evidence-manifest.v1.json",
      ),
    );
    assert.equal(provider.cost.unit, "PROCESS_EXECUTIONS");
    assert.ok(provider.limits.some((limit) => limit.includes("does not prove that a control ran")));
    const { manifestDigest, ...projection } = provider;
    assert.equal(manifestDigest, core.sha256Canonical(projection));
  });

  it("keeps an uncaptured or invalid build source revision UNKNOWN", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "assertledger-build-info-"));
    try {
      const location = pathToFileURL(path.join(directory, "build-info.json"));
      assert.deepEqual(buildInfo.readSourceRevision(location), { status: "UNKNOWN" });
      await writeFile(location, "{not json");
      assert.deepEqual(buildInfo.readSourceRevision(location), { status: "UNKNOWN" });
      await writeFile(
        location,
        JSON.stringify({
          sourceRevision: { status: "RECORDED", commit: "HEAD", worktree: "CLEAN" },
        }),
      );
      assert.deepEqual(buildInfo.readSourceRevision(location), { status: "UNKNOWN" });
      const recorded = { status: "RECORDED", commit: "c".repeat(40), worktree: "CLEAN" };
      await writeFile(location, JSON.stringify({ sourceRevision: recorded }));
      assert.deepEqual(buildInfo.readSourceRevision(location), recorded);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts only an exact recorded source revision", () => {
    const recorded = core.createEvidenceProviderManifest({
      version: "1.0.0",
      sourceRevision: { status: "RECORDED", commit: "a".repeat(40), worktree: "DIRTY" },
      adapters: [],
    });
    assert.deepEqual(recorded.provider.sourceRevision, {
      status: "RECORDED",
      commit: "a".repeat(40),
      worktree: "DIRTY",
    });
    assert.throws(
      () =>
        contracts.parseEvidenceProviderManifest({
          ...recorded,
          provider: {
            ...recorded.provider,
            sourceRevision: { status: "RECORDED", commit: "HEAD", worktree: "CLEAN" },
          },
        }),
      contracts.ContractError,
    );
  });
});

describe("evidence export", () => {
  it("exports verified evidence as an observed regression assertion bound to its digests", () => {
    const manifest = manifestFixture({ nodeTestProfile: true });
    const exported = exportOf(manifest);

    assert.deepEqual(contracts.parseEvidenceExport(exported), exported);
    assert.deepEqual(exported.sourceManifest, manifest);
    assert.equal(exported.sourceArtifactDigest, manifest.artifactDigest);
    assert.deepEqual(
      [exported.result.detection, exported.result.modality, exported.result.reasonCode],
      ["OBSERVED", "TEST_OBSERVED", "REGRESSION_ASSERTION_OBSERVED"],
    );
    assert.deepEqual(exported.result.decision, manifest.decision);
    const [candidate] = exported.result.candidates;
    assert.equal(candidate?.selected, true);
    assert.deepEqual(
      candidate?.worlds.map((world) => [
        world.worldId,
        world.outcome,
        world.signal,
        world.detection,
      ]),
      [
        ["neutral", "PASS", "GREEN", "NOT_APPLICABLE"],
        ["reference", "PASS", "GREEN", "NOT_APPLICABLE"],
        ["target", "ASSERTION_FAILURE", "RED", "OBSERVED"],
      ],
    );
    assert.deepEqual(exported.integrity, {
      sourceReplay: "VALID",
      verifiedRails: ["SCHEMA", "DECISION_DIGEST", "ARTIFACT_DIGEST", "DECISION_SEMANTICS"],
      bindings: {
        artifactDigest: manifest.artifactDigest,
        decisionDigest: manifest.decisionDigest,
        repositoryDigest: manifest.repositoryDigest,
        policyDigest: core.sha256Canonical(manifest.policy),
        worldDigests: [
          { worldId: "neutral", digest: digest("neutral") },
          { worldId: "reference", digest: digest("reference") },
          { worldId: "target", digest: digest("target") },
        ],
      },
    });
    assert.deepEqual(exported.authenticity, {
      status: "UNAUTHENTICATED",
      attestation: "NONE",
      declaredProducer: { name: "testforge", version: "0.1.0" },
    });
    assert.deepEqual(exported.environment.isolation, {
      kind: "trusted-local",
      level: "UNSANDBOXED",
    });
    assert.deepEqual(exported.environment.adapter.framework, {
      status: "RECORDED",
      profileId: "node-test",
      profileVersion: "1.0.0",
      official: true,
      nodeVersion: "v22.15.0",
      executableDigest: digest("node-executable"),
    });
    assert.equal(exported.confidence.level, "REPLAY_CONSISTENT_UNAUTHENTICATED");
    for (const property of [
      "PRODUCER_AUTHENTICITY",
      "OBSERVATION_TRUTHFULNESS",
      "EXECUTION_ISOLATION",
      "EXECUTION_FRESHNESS",
    ] as const) {
      assert.ok(exported.confidence.notEstablished.includes(property), property);
    }
    assert.equal(exported.exportDigest, core.sha256Canonical(withoutDigest(exported)));
  });

  it("exports observed non-detection as negative test evidence", () => {
    const manifest = manifestFixture({ targetOutcome: "PASS" });
    assert.equal(manifest.decision.status, "REJECTED");
    const exported = exportOf(manifest);

    assert.deepEqual(
      [exported.result.detection, exported.result.modality, exported.result.reasonCode],
      ["NOT_OBSERVED", "TEST_OBSERVED", "TARGET_PASSED_WITHOUT_DETECTION"],
    );
    const target = exported.result.candidates[0]?.worlds.find(
      (world) => world.worldId === "target",
    );
    assert.deepEqual([target?.signal, target?.detection], ["GREEN", "NOT_OBSERVED"]);
  });

  it("never promotes operational outcomes to detection evidence", () => {
    for (const outcome of OPERATIONAL_OUTCOMES) {
      const manifest = manifestFixture({ targetOutcome: outcome });
      assert.notEqual(manifest.decision.status, "VERIFIED", outcome);
      const exported = exportOf(manifest);
      assert.equal(exported.result.detection, "NOT_ESTABLISHED", outcome);
      assert.equal(exported.result.modality, "NONE", outcome);
      assert.ok(
        [
          "CANDIDATE_EVIDENCE_INCONCLUSIVE",
          "CANDIDATE_EVIDENCE_INVALID",
          "OPERATIONAL_OUTCOME_NOT_DETECTION",
        ].includes(exported.result.reasonCode),
        `${outcome}: ${exported.result.reasonCode}`,
      );
      for (const candidate of exported.result.candidates) {
        for (const world of candidate.worlds) {
          assert.notEqual(world.detection, "OBSERVED", outcome);
          assert.notEqual(world.detection, "NOT_OBSERVED", outcome);
          if (world.kind === "TARGET") assert.equal(world.signal, "NONE", outcome);
        }
      }
    }
  });

  it("does not establish detection when controls are invalid", () => {
    const exported = exportOf(manifestFixture({ invalidControls: true }));
    assert.deepEqual(
      [exported.result.detection, exported.result.reasonCode],
      ["NOT_ESTABLISHED", "CONTROL_EVIDENCE_INVALID"],
    );
  });

  it("refuses replay-invalid source evidence before exporting", () => {
    const rawTamper = structuredClone(manifestFixture());
    rawTamper.observations[0] = { ...rawTamper.observations[0], outcome: "TIMEOUT" } as never;
    assert.throws(() => exportOf(rawTamper), /EVIDENCE_EXPORT_SOURCE_INVALID/);

    // Graft genuine VERIFIED assessment rows onto weak observations, then reseal both digests.
    const forged = structuredClone(manifestFixture({ targetOutcome: "PASS" }));
    const verified = manifestFixture();
    forged.candidates = structuredClone(verified.candidates);
    forged.decision = structuredClone(verified.decision);
    forged.decisionDigest = core.sha256Canonical(decisionDigestProjection(forged));
    const resealed = core.sealManifestArtifact(forged);
    const replay = core.replayEvidenceManifest(resealed);
    assert.equal(replay.decisionDigestValid, true);
    assert.equal(replay.artifactDigestValid, true);
    assert.equal(replay.decisionSemanticsValid, false);
    assert.throws(() => exportOf(resealed), /EVIDENCE_EXPORT_SOURCE_INVALID/);
  });

  it("is deterministic and replayable from the same artifact", () => {
    const manifest = manifestFixture({ git: "ALL", nodeTestProfile: true });
    const first = exportOf(manifest);
    const again = exportOf(JSON.parse(JSON.stringify(manifest)));
    const permuted = exportOf(reversedKeys(manifest));

    assert.equal(core.canonicalize(again), core.canonicalize(first));
    assert.equal(core.canonicalize(permuted), core.canonicalize(first));
    assert.deepEqual(core.replayEvidenceExport(first), {
      valid: true,
      schemaValid: true,
      sourceManifestValid: true,
      exportDigestValid: true,
      semanticsValid: true,
    });
    assert.equal(core.replayEvidenceExport(JSON.parse(JSON.stringify(first))).valid, true);
  });

  it("fails export replay closed on tampering and forged re-digests", () => {
    const exported = exportOf(manifestFixture({ targetOutcome: "PASS" }));

    const rawTamper = structuredClone(exported);
    rawTamper.result.detection = "OBSERVED";
    assert.deepEqual(
      [
        core.replayEvidenceExport(rawTamper).valid,
        core.replayEvidenceExport(rawTamper).exportDigestValid,
      ],
      [false, false],
    );

    const redigested = structuredClone(exported);
    redigested.result.detection = "OBSERVED";
    redigested.result.reasonCode = "REGRESSION_ASSERTION_OBSERVED";
    redigested.exportDigest = core.sha256Canonical(withoutDigest(redigested));
    assert.deepEqual(core.replayEvidenceExport(redigested), {
      valid: false,
      schemaValid: true,
      sourceManifestValid: true,
      exportDigestValid: true,
      semanticsValid: false,
    });

    const swappedSource = structuredClone(exported);
    swappedSource.sourceManifest = manifestFixture();
    swappedSource.exportDigest = core.sha256Canonical(withoutDigest(swappedSource));
    const swapped = core.replayEvidenceExport(swappedSource);
    assert.equal(swapped.valid, false);
    assert.equal(swapped.semanticsValid, false);

    assert.deepEqual(core.replayEvidenceExport({ ...exported, unexpected: true }), {
      valid: false,
      schemaValid: false,
      sourceManifestValid: false,
      exportDigestValid: false,
      semanticsValid: false,
    });
  });

  it("maps consumer obligations to executed, missing and unsupported controls", () => {
    const manifest = manifestFixture();
    const plain = exportOf(manifest);
    const requested = core.createEvidenceExport(
      contracts.parseEvidenceExportRequest(
        exportRequest(manifest, {
          reference: "consumer-request-7",
          profileId: "agentic-fast",
          obligations: [
            { id: "detect", control: "REGRESSION_DETECTION" },
            { id: "repeat", control: "STABILITY_REPETITION" },
            { id: "sandbox", control: "SANDBOXED_EXECUTION" },
          ],
        }),
      ),
    );

    assert.deepEqual(requested.result, plain.result);
    assert.deepEqual(requested.consumerRequest?.reference, "consumer-request-7");
    assert.deepEqual(requested.controls.requested, {
      status: "PARTIAL",
      obligations: [
        { id: "detect", control: "REGRESSION_DETECTION", coverage: "EXECUTED" },
        { id: "repeat", control: "STABILITY_REPETITION", coverage: "EXECUTED" },
        { id: "sandbox", control: "SANDBOXED_EXECUTION", coverage: "UNSUPPORTED" },
      ],
    });
    assert.deepEqual(requested.profile, {
      status: "UNKNOWN_PROFILE",
      requestedProfileId: "agentic-fast",
    });
    assert.deepEqual(plain.controls.requested, { status: "NOT_SUPPLIED" });
    assert.deepEqual(plain.profile, { status: "NOT_REQUESTED" });
    assert.deepEqual(
      plain.controls.executed.map((control) => [
        control.control,
        control.status,
        control.observations,
      ]),
      [
        ["CONTROL_WITHOUT_CANDIDATE", "EXECUTED", 9],
        ["REFERENCE_PASS", "EXECUTED", 3],
        ["REGRESSION_DETECTION", "EXECUTED", 3],
        ["NEUTRAL_PASS", "EXECUTED", 3],
        ["STABILITY_REPETITION", "EXECUTED", 12],
      ],
    );
  });

  it("rejects ambiguous consumer requests", () => {
    assert.throws(
      () =>
        contracts.parseEvidenceExportRequest(
          exportRequest(manifestFixture(), {
            reference: null,
            profileId: null,
            obligations: [
              { id: "same", control: "REGRESSION_DETECTION" },
              { id: "same", control: "REFERENCE_PASS" },
            ],
          }),
        ),
      /EVIDENCE_EXPORT_REQUEST_INVALID/,
    );
  });

  it("records Git revisions only from exact recorded provenance", () => {
    const all = exportOf(manifestFixture({ git: "ALL" }));
    assert.equal(all.scope.gitRevisions, "RECORDED");
    assert.deepEqual(all.scope.worlds.find((world) => world.id === "target")?.git, {
      role: "target",
      commit: "b".repeat(40),
      tree: "e".repeat(40),
      objectFormat: "sha1",
    });
    assert.equal(exportOf(manifestFixture({ git: "PARTIAL" })).scope.gitRevisions, "PARTIAL");
    const none = exportOf(manifestFixture({ git: "NONE" }));
    assert.equal(none.scope.gitRevisions, "NOT_RECORDED");
    assert.ok(none.scope.worlds.every((world) => world.git === null));
    assert.equal(none.scope.worlds[0]?.declaredProvenance, "fixture:neutral");
  });

  it("separates estimated cost, observed cost and unknown execution freshness", () => {
    const timed = exportOf(manifestFixture());
    assert.deepEqual(timed.cost.estimated.value, 18);
    assert.deepEqual(
      [timed.cost.observed.executions, timed.cost.observed.recordedWallTimeMs],
      [18, 225],
    );
    assert.equal(timed.cost.observed.wallTimeCoverage, "COMPLETE");
    assert.deepEqual(timed.cost.execution, { freshness: "UNKNOWN", cache: "NOT_RECORDED" });

    const untimed = exportOf(manifestFixture({ durations: false }));
    assert.deepEqual(
      [untimed.cost.observed.recordedWallTimeMs, untimed.cost.observed.wallTimeCoverage],
      [null, "NOT_RECORDED"],
    );
    assert.equal(untimed.environment.adapter.framework.status, "UNKNOWN");
  });

  it("keeps AssertLedger autonomous from any evidence consumer", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const dependencies = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ];
    assert.equal(
      dependencies.some((name) => /semctx/i.test(name)),
      false,
    );
    const sourceFiles = (await readdir("src", { recursive: true })).filter((file) =>
      file.endsWith(".ts"),
    );
    for (const file of sourceFiles) {
      assert.doesNotMatch(await readFile(path.join("src", file), "utf8"), /semctx/i, file);
    }

    const manifest = manifestFixture();
    const before = core.canonicalize(manifest);
    const exported = exportOf(manifest);
    const rejectedByConsumer = structuredClone(exported) as Record<string, unknown>;
    rejectedByConsumer.result = { detection: "REJECTED_BY_CONSUMER" };
    delete rejectedByConsumer.sourceManifest;
    assert.equal(core.canonicalize(manifest), before);
    assert.equal(core.replayEvidenceManifest(manifest).valid, true);
    assert.equal(core.canonicalize(exportOf(manifest)), core.canonicalize(exported));
  });

  it("exposes export, replay and provider identity through the SDK facade", async () => {
    const packageVersion = (
      JSON.parse(await readFile("package.json", "utf8")) as { version: string }
    ).version;
    const assertLedger = new sdk.AssertLedger();
    const manifest = manifestFixture();
    const exported = assertLedger.exportEvidence(exportRequest(manifest));
    assert.equal(core.canonicalize(exported), core.canonicalize(exportOf(manifest)));
    assert.equal(assertLedger.replayEvidenceExport(exported).valid, true);
    assert.deepEqual(assertLedger.replayEvidenceExport({ nope: true }), {
      valid: false,
      schemaValid: false,
      sourceManifestValid: false,
      exportDigestValid: false,
      semanticsValid: false,
    });
    const provider = assertLedger.providerManifest();
    assert.deepEqual(contracts.parseEvidenceProviderManifest(provider), provider);
    assert.equal(provider.provider.version, packageVersion);
    assert.deepEqual(provider.provider.sourceRevision, { status: "UNKNOWN" });
    assert.deepEqual(
      provider.adapters.map((adapter) => adapter.kind),
      ["node-test", "testforge-command"],
    );
    assert.throws(
      () =>
        assertLedger.exportEvidence(exportRequest({ ...manifest, artifactDigest: digest("x") })),
      /EVIDENCE_EXPORT_SOURCE_INVALID/,
    );
  });
});
