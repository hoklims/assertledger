import assert from "node:assert/strict";
import { describe, it } from "node:test";

type CoreApi = {
  canonicalize(value: unknown): string;
  sha256Canonical(value: unknown): string;
  decideEvidence(input: unknown): any;
  selectCandidates(assessments: unknown[], maximum: number): string[];
  assertSafeRelativePath(path: string, roots: string[]): string;
  portablePathKey(path: string): string;
  verifyDecisionDigest(manifest: unknown): { valid: boolean };
  verifyManifestIntegrity(manifest: unknown): {
    valid: boolean;
    decisionDigestValid: boolean;
    artifactDigestValid: boolean;
  };
  replayEvidenceManifest(manifest: unknown): {
    valid: boolean;
    decisionDigestValid: boolean;
    artifactDigestValid: boolean;
    decisionSemanticsValid: boolean;
  };
  sealManifestArtifact<T extends Record<string, unknown>>(
    manifest: T,
  ): T & { artifactDigest: string };
};

async function loadCore(): Promise<CoreApi> {
  try {
    return (await import("../src/core/index.js")) as CoreApi;
  } catch {
    return {
      canonicalize: () => "UNIMPLEMENTED",
      sha256Canonical: () => "UNIMPLEMENTED",
      decideEvidence: () => ({
        decision: { status: "ENGINE_ERROR", selectedCandidateIds: [] },
        candidates: [],
        decisionDigest: "UNIMPLEMENTED",
      }),
      selectCandidates: () => [],
      assertSafeRelativePath: () => "UNIMPLEMENTED",
      portablePathKey: () => "UNIMPLEMENTED",
      verifyDecisionDigest: () => ({ valid: false }),
      verifyManifestIntegrity: () => ({
        valid: false,
        decisionDigestValid: false,
        artifactDigestValid: false,
      }),
      replayEvidenceManifest: () => ({
        valid: false,
        decisionDigestValid: false,
        artifactDigestValid: false,
        decisionSemanticsValid: false,
      }),
      sealManifestArtifact: (manifest) => ({ ...manifest, artifactDigest: "UNIMPLEMENTED" }),
    };
  }
}

const core = await loadCore();

function fixtureDigest(label: string): string {
  return core.sha256Canonical({ fixture: label });
}

function observation(
  candidateId: string | null,
  worldId: string,
  attempt: number,
  outcome: string,
  candidateTestsDiscovered = candidateId === null ? 0 : 1,
  attributed = candidateId !== null,
) {
  return {
    runId: `${candidateId ?? "control"}:${worldId}:${attempt}`,
    candidateId,
    worldId,
    attempt,
    outcome,
    testsDiscovered: candidateId === null ? 1 : 2,
    candidateTestsDiscovered,
    attributed,
    durationMs: 17 + attempt,
    exitCode: outcome === "PASS" ? 0 : 1,
    stdoutDigest: fixtureDigest(`stdout:${candidateId ?? "control"}:${worldId}:${attempt}`),
    stderrDigest: fixtureDigest(`stderr:${candidateId ?? "control"}:${worldId}:${attempt}`),
  };
}

function campaign(candidateOrder = ["candidate-a", "candidate-b"]) {
  const worlds = [
    { id: "reference", kind: "REFERENCE", required: true, weight: 0 },
    { id: "target-off-by-one", kind: "TARGET", required: true, weight: 3 },
    { id: "target-overflow", kind: "TARGET", required: false, weight: 2 },
    { id: "neutral-refactor", kind: "NEUTRAL", required: true, weight: 0 },
  ];
  const observations = worlds.flatMap((world) => [
    observation(null, world.id, 1, "PASS"),
    observation(null, world.id, 2, "PASS"),
  ]);

  for (const candidateId of candidateOrder) {
    for (const world of worlds) {
      const strong = candidateId === "candidate-a";
      const outcome =
        world.kind === "TARGET" && (strong || world.required) ? "ASSERTION_FAILURE" : "PASS";
      observations.push(observation(candidateId, world.id, 1, outcome));
      observations.push(observation(candidateId, world.id, 2, outcome));
    }
  }

  return {
    schemaVersion: "1.0.0",
    repositoryDigest: fixtureDigest("repository"),
    evidenceContext: {
      engine: { name: "testforge", version: "0.1.0" },
      adapter: {
        name: "node-test",
        version: process.versions.node,
        configuration: {
          executable: process.execPath,
          arguments: ["--test"],
        },
      },
      execution: {
        isolation: "UNSANDBOXED",
        environmentAllowlist: ["PATH", "SystemRoot"],
        budgets: { timeoutMsPerExecution: 5_000, maximumOutputBytes: 65_536 },
        candidateRoots: ["tests/candidates"],
      },
      worlds: worlds.map((world) => ({
        id: world.id,
        provenance: `fixture:${world.id}`,
        digest: fixtureDigest(`world:${world.id}`),
      })),
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 2,
      minimumTargetWeightPermille: 600,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds,
    candidates: candidateOrder.map((id) => ({
      id,
      digest: fixtureDigest(`candidate:${id}`),
      sizeBytes: id === "candidate-a" ? 200 : 100,
    })),
    observations,
  };
}

describe("canonical evidence", () => {
  it("canonicalizes object keys independently of insertion order", () => {
    const left = { z: 1, nested: { b: true, a: [3, 2, 1] }, a: "value" };
    const right = { a: "value", nested: { a: [3, 2, 1], b: true }, z: 1 };

    assert.equal(core.canonicalize(left), core.canonicalize(right));
    assert.equal(core.sha256Canonical(left), core.sha256Canonical(right));
    assert.match(core.sha256Canonical(left), /^sha256:[a-f0-9]{64}$/);
  });

  it("rejects values outside canonical JSON", () => {
    assert.throws(() => core.canonicalize({ invalid: Number.NaN }), /finite|JSON/i);
    assert.throws(() => core.canonicalize({ invalid: undefined }), /undefined|JSON/i);
  });
});

describe("deterministic decision", () => {
  it("rejects evidence that omits the execution provenance context", () => {
    const input = campaign();
    delete (input as Partial<typeof input>).evidenceContext;

    const manifest = core.decideEvidence(input);

    assert.equal(manifest.decision.status, "ENGINE_ERROR");
    assert.deepEqual(manifest.decision.reasonCodes, ["EVIDENCE_INPUT_INVALID"]);
  });

  it("verifies a stable candidate that passes reference and neutral worlds and kills targets", () => {
    const manifest = core.decideEvidence(campaign());

    assert.equal(manifest.decision.status, "VERIFIED");
    assert.deepEqual(manifest.decision.selectedCandidateIds, ["candidate-a"]);
    assert.equal(manifest.candidates[0].status, "ELIGIBLE");
    assert.equal(manifest.candidates[0].targetWeightKilled, 5);
  });

  it("does not count compilation failures as target discrimination", () => {
    const input = campaign(["candidate-a"]);
    for (const run of input.observations) {
      if (run.candidateId === "candidate-a" && run.worldId.startsWith("target-")) {
        run.outcome = "COMPILE_FAILURE";
      }
    }

    const manifest = core.decideEvidence(input);

    assert.equal(manifest.decision.status, "REJECTED");
    assert.equal(manifest.candidates[0].status, "WEAK_ORACLE");
  });

  it("does not let a caller configure collection failures as target evidence", () => {
    const input = campaign(["candidate-a"]);
    input.policy.acceptedTargetOutcomes = ["COLLECTION_FAILURE"];
    for (const run of input.observations) {
      if (run.candidateId === "candidate-a" && run.worldId.startsWith("target-")) {
        run.outcome = "COLLECTION_FAILURE";
      }
    }

    const manifest = core.decideEvidence(input);

    assert.equal(manifest.decision.status, "ENGINE_ERROR");
    assert.deepEqual(manifest.decision.selectedCandidateIds, []);
    assert.deepEqual(manifest.decision.reasonCodes, ["EVIDENCE_INPUT_INVALID"]);
  });

  it("rejects unknown schema and policy versions at the direct core boundary", () => {
    const unknownSchema = campaign(["candidate-a"]);
    unknownSchema.schemaVersion = "2.0.0";
    const unknownPolicy = campaign(["candidate-a"]);
    unknownPolicy.policy.policyVersion = "2.0.0";

    for (const input of [unknownSchema, unknownPolicy]) {
      const manifest = core.decideEvidence(input);
      assert.equal(manifest.decision.status, "ENGINE_ERROR");
      assert.deepEqual(manifest.decision.reasonCodes, ["EVIDENCE_INPUT_INVALID"]);
    }
  });

  it("accepts only the exact singleton assertion-failure outcome policy", () => {
    const policies = [[], ["ASSERTION_FAILURE", "ASSERTION_FAILURE"], ["PASS"]];

    for (const acceptedTargetOutcomes of policies) {
      const input = campaign(["candidate-a"]);
      input.policy.acceptedTargetOutcomes = acceptedTargetOutcomes;
      const manifest = core.decideEvidence(input);
      assert.equal(manifest.decision.status, "ENGINE_ERROR");
      assert.deepEqual(manifest.decision.reasonCodes, ["EVIDENCE_INPUT_INVALID"]);
    }
  });

  it("enforces core policy bounds independently of the request contract", () => {
    const zeroThreshold = campaign(["candidate-a"]);
    zeroThreshold.policy.minimumTargetWeightPermille = 0;
    const zeroSelection = campaign(["candidate-a"]);
    zeroSelection.policy.maximumSelectedCandidates = 0;

    for (const input of [zeroThreshold, zeroSelection]) {
      const manifest = core.decideEvidence(input);
      assert.equal(manifest.decision.status, "ENGINE_ERROR");
      assert.deepEqual(manifest.decision.reasonCodes, ["EVIDENCE_INPUT_INVALID"]);
    }
  });

  it("requires candidates and one required world of every kind with portable weights", () => {
    const noCandidates = campaign(["candidate-a"]);
    noCandidates.candidates = [];
    noCandidates.observations = noCandidates.observations.filter((run) => run.candidateId === null);

    const optionalNeutral = campaign(["candidate-a"]);
    const neutral = optionalNeutral.worlds.find((world) => world.kind === "NEUTRAL");
    assert.ok(neutral);
    neutral.required = false;

    const zeroTargetWeight = campaign(["candidate-a"]);
    const target = zeroTargetWeight.worlds.find((world) => world.kind === "TARGET");
    assert.ok(target);
    target.weight = 0;

    const weightedReference = campaign(["candidate-a"]);
    const reference = weightedReference.worlds.find((world) => world.kind === "REFERENCE");
    assert.ok(reference);
    reference.weight = 1;

    for (const input of [noCandidates, optionalNeutral, zeroTargetWeight, weightedReference]) {
      const manifest = core.decideEvidence(input);
      assert.equal(manifest.decision.status, "ENGINE_ERROR");
      assert.deepEqual(manifest.decision.reasonCodes, ["EVIDENCE_INPUT_INVALID"]);
    }
  });

  it("rejects non-portable candidate identifiers at the core boundary", () => {
    const input = campaign(["candidate-a"]);
    const firstCandidate = input.candidates[0];
    assert.ok(firstCandidate);
    firstCandidate.id = "candidat-é";
    for (const run of input.observations) {
      if (run.candidateId === "candidate-a") run.candidateId = "candidat-é";
    }

    const manifest = core.decideEvidence(input);

    assert.equal(manifest.decision.status, "ENGINE_ERROR");
    assert.deepEqual(manifest.decision.reasonCodes, ["EVIDENCE_INPUT_INVALID"]);
  });

  it("rejects impossible candidate discovery attribution", () => {
    const input = campaign(["candidate-a"]);
    const firstObservation = input.observations[0];
    assert.ok(firstObservation);
    firstObservation.candidateTestsDiscovered = firstObservation.testsDiscovered + 1;

    const manifest = core.decideEvidence(input);

    assert.equal(manifest.decision.status, "ENGINE_ERROR");
    assert.deepEqual(manifest.decision.reasonCodes, ["EVIDENCE_INPUT_INVALID"]);
  });

  it("accepts only the eight version-one observation outcomes", () => {
    const input = campaign(["candidate-a"]);
    const firstObservation = input.observations[0];
    assert.ok(firstObservation);
    firstObservation.outcome = "MAGICAL_SUCCESS";

    const manifest = core.decideEvidence(input);

    assert.equal(manifest.decision.status, "ENGINE_ERROR");
    assert.deepEqual(manifest.decision.reasonCodes, ["EVIDENCE_INPUT_INVALID"]);
  });

  it("rejects non-SHA-256 digests on every published evidence boundary", () => {
    const inputs = Array.from({ length: 5 }, () => campaign(["candidate-a"]));
    const [repository, candidateInput, worldInput, stdoutInput, stderrInput] = inputs;
    assert.ok(repository && candidateInput && worldInput && stdoutInput && stderrInput);
    const candidate = candidateInput.candidates[0];
    const contextWorld = worldInput.evidenceContext.worlds[0];
    const stdoutObservation = stdoutInput.observations[0];
    const stderrObservation = stderrInput.observations[0];
    assert.ok(candidate && contextWorld && stdoutObservation && stderrObservation);
    repository.repositoryDigest = "sha256:not-a-digest";
    candidate.digest = "sha256:not-a-digest";
    contextWorld.digest = "sha256:not-a-digest";
    stdoutObservation.stdoutDigest = "sha256:not-a-digest";
    stderrObservation.stderrDigest = `SHA256:${"A".repeat(64)}`;

    for (const input of inputs) {
      const manifest = core.decideEvidence(input);
      assert.equal(manifest.decision.status, "ENGINE_ERROR");
      assert.deepEqual(manifest.decision.reasonCodes, ["EVIDENCE_INPUT_INVALID"]);
    }
  });

  it("rejects evident evidence-manifest bound violations", () => {
    const attempts = campaign(["candidate-a"]);
    attempts.policy.requiredAttempts = 1_001;
    const selection = campaign(["candidate-a"]);
    selection.policy.maximumSelectedCandidates = 1_001;
    const weight = campaign(["candidate-a"]);
    const target = weight.worlds.find((world) => world.kind === "TARGET");
    assert.ok(target);
    target.weight = 1_000_001;
    const provenance = campaign(["candidate-a"]);
    const contextWorld = provenance.evidenceContext.worlds[0];
    assert.ok(contextWorld);
    contextWorld.provenance = "p".repeat(1_025);

    for (const input of [attempts, selection, weight, provenance]) {
      assert.equal(core.decideEvidence(input).decision.status, "ENGINE_ERROR");
    }
  });

  it("does not mask unexpected decision-engine exceptions as invalid evidence", () => {
    const input = campaign(["candidate-a"]);
    for (const run of input.observations) {
      if (run.candidateId === "candidate-a" && run.worldId === "target-off-by-one") {
        run.outcome = "TIMEOUT";
      }
    }
    const originalHas = Set.prototype.has;
    let timeoutChecks = 0;
    Set.prototype.has = function hasWithInjectedDecisionFailure(value: unknown): boolean {
      if (value === "TIMEOUT" && ++timeoutChecks > 2) {
        throw new Error("forced internal decision failure");
      }
      return originalHas.call(this, value);
    };
    try {
      assert.throws(() => core.decideEvidence(input), /forced internal decision failure/);
    } finally {
      Set.prototype.has = originalHas;
    }
  });

  it("is inconclusive rather than an engine error when control evidence is not green", () => {
    const input = campaign(["candidate-a"]);
    const control = input.observations.find(
      (run) => run.candidateId === null && run.worldId === "target-off-by-one",
    );
    assert.ok(control);
    control.outcome = "PROCESS_CRASH";

    const manifest = core.decideEvidence(input);

    assert.equal(manifest.decision.status, "INCONCLUSIVE");
    assert.ok(manifest.decision.reasonCodes.includes("CONTROL_EVIDENCE_INVALID"));
  });

  it("is inconclusive when a target attempt times out", () => {
    const input = campaign(["candidate-a"]);
    for (const run of input.observations) {
      if (run.candidateId === "candidate-a" && run.worldId === "target-off-by-one") {
        run.outcome = "TIMEOUT";
      }
    }

    const manifest = core.decideEvidence(input);

    assert.equal(manifest.decision.status, "INCONCLUSIVE");
    assert.equal(manifest.candidates[0].status, "INCONCLUSIVE");
  });

  it("does not let an inconclusive candidate poison an independently eligible selection", () => {
    const input = campaign(["candidate-a", "candidate-b"]);
    for (const run of input.observations) {
      if (run.candidateId === "candidate-b" && run.worldId.startsWith("target-")) {
        run.outcome = "TIMEOUT";
      }
    }

    const manifest = core.decideEvidence(input);

    assert.equal(
      manifest.candidates.find((candidate: any) => candidate.id === "candidate-b").status,
      "INCONCLUSIVE",
    );
    assert.equal(manifest.decision.status, "VERIFIED");
    assert.deepEqual(manifest.decision.selectedCandidateIds, ["candidate-a"]);
    assert.deepEqual(manifest.decision.reasonCodes, ["POLICY_SATISFIED"]);
  });

  it("is inconclusive when repeated observations disagree", () => {
    const input = campaign(["candidate-a"]);
    const flaky = input.observations.find(
      (run) =>
        run.candidateId === "candidate-a" && run.worldId === "reference" && run.attempt === 2,
    );
    assert.ok(flaky);
    flaky.outcome = "ASSERTION_FAILURE";

    const manifest = core.decideEvidence(input);

    assert.equal(manifest.decision.status, "INCONCLUSIVE");
    assert.equal(manifest.candidates[0].status, "UNSTABLE");
  });

  it("links candidate gate results to the observations that justify them", () => {
    const manifest = core.decideEvidence(campaign(["candidate-a"]));
    const targetGate = manifest.candidates[0].gates.find(
      (gate: any) => gate.name === "TARGET_STRENGTH",
    );

    assert.ok(targetGate);
    assert.equal(targetGate.status, "PASSED");
    assert.ok(targetGate.evidenceRunIds.includes("candidate-a:target-off-by-one:1"));
    assert.deepEqual(manifest.candidates[0].reasonCodes, ["POLICY_SATISFIED"]);
  });

  it("produces the same selection and digest for candidate permutations", () => {
    const first = core.decideEvidence(campaign(["candidate-a", "candidate-b"]));
    const second = core.decideEvidence(campaign(["candidate-b", "candidate-a"]));

    assert.deepEqual(first.decision, second.decision);
    assert.equal(first.decisionDigest, second.decisionDigest);
  });

  it("uses ordinal ordering without consulting the host locale", () => {
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("host locale must not affect deterministic decisions");
    };
    try {
      const input = campaign(["candidate-z", "candidate-_"]);
      const manifest = core.decideEvidence(input);
      assert.notEqual(manifest.decision.status, "ENGINE_ERROR");
    } finally {
      String.prototype.localeCompare = original;
    }
  });
});

describe("selection", () => {
  it("uses deterministic marginal target coverage before patch size", () => {
    const selected = core.selectCandidates(
      [
        {
          id: "a",
          digest: "sha256:a",
          status: "ELIGIBLE",
          killedTargetIds: ["x", "y"],
          targetWeightKilled: 2,
          sizeBytes: 200,
        },
        {
          id: "b",
          digest: "sha256:b",
          status: "ELIGIBLE",
          killedTargetIds: ["y", "z"],
          targetWeightKilled: 2,
          sizeBytes: 100,
        },
        {
          id: "c",
          digest: "sha256:c",
          status: "ELIGIBLE",
          killedTargetIds: ["x"],
          targetWeightKilled: 1,
          sizeBytes: 50,
        },
      ],
      2,
    );

    assert.deepEqual(selected, ["b", "c"]);
  });
});

describe("boundary safety", () => {
  it("accepts normalized test paths and rejects traversal, absolute paths, and Windows ADS", () => {
    assert.equal(
      core.assertSafeRelativePath("tests/unit/example.test.js", ["tests"]),
      "tests/unit/example.test.js",
    );
    assert.throws(() => core.assertSafeRelativePath("../src/index.js", ["tests"]));
    assert.throws(() => core.assertSafeRelativePath("C:\\src\\index.js", ["tests"]));
    assert.throws(() => core.assertSafeRelativePath("tests/file.js:payload", ["tests"]));
  });

  it("rejects Windows device names even with extensions and mixed casing", () => {
    for (const path of [
      "tests/CON.test.js",
      "tests/AUX",
      "tests/nul.txt",
      "tests/Com1.js",
      "tests/lPt9.spec.ts",
    ]) {
      assert.throws(() => core.assertSafeRelativePath(path, ["tests"]), /device|reserved/i);
    }
  });

  it("rejects control characters and Windows-forbidden filename characters", () => {
    for (const character of ["<", ">", '"', "|", "?", "*", "\u0001", "\u007f"]) {
      assert.throws(
        () => core.assertSafeRelativePath(`tests/bad${character}name.js`, ["tests"]),
        /character|path/i,
      );
    }
  });

  it("produces deterministic NFC case-insensitive keys for portable collision detection", () => {
    assert.equal(core.portablePathKey("tests/a.js"), core.portablePathKey("tests/A.js"));
    assert.equal(core.portablePathKey("Tests/CAFÉ.js"), "tests/café.js");

    const decomposed = "tests/cafe\u0301.js";
    assert.throws(() => core.portablePathKey(decomposed), /unicode|NFC|ambiguous/i);
    assert.equal(core.portablePathKey("tests/café.js"), "tests/café.js");
  });
});

describe("manifest integrity", () => {
  it("detects decision-relevant tampering", () => {
    const manifest = core.decideEvidence(campaign());
    assert.equal(core.verifyDecisionDigest(manifest).valid, true);

    manifest.candidates[0].status = "REJECTED";
    assert.equal(core.verifyDecisionDigest(manifest).valid, false);
  });

  it("excludes volatile durations from the decision digest", () => {
    const manifest = core.decideEvidence(campaign());
    manifest.observations[0].durationMs += 9_999;

    assert.equal(core.verifyDecisionDigest(manifest).valid, true);
  });

  it("binds engine, adapter, execution and world provenance into the decision digest", () => {
    const manifest = core.decideEvidence(campaign());
    assert.equal(core.verifyManifestIntegrity(manifest).valid, true);

    manifest.evidenceContext.worlds[0].provenance = "tampered:source";

    const integrity = core.verifyManifestIntegrity(manifest);
    assert.equal(integrity.decisionDigestValid, false);
    assert.equal(integrity.artifactDigestValid, false);
    assert.equal(integrity.valid, false);
  });

  it("preserves run metadata and binds operational changes only into the artifact digest", () => {
    const manifest = core.decideEvidence(campaign());
    assert.equal(manifest.observations[0].exitCode, 0);
    assert.match(manifest.observations[0].stdoutDigest, /^sha256:/);
    assert.match(manifest.observations[0].stderrDigest, /^sha256:/);

    manifest.observations[0].durationMs += 1;
    manifest.observations[0].stdoutDigest = "sha256:tampered-log";

    const integrity = core.verifyManifestIntegrity(manifest);
    assert.equal(integrity.decisionDigestValid, true);
    assert.equal(integrity.artifactDigestValid, false);
    assert.equal(integrity.valid, false);
  });

  it("replays an authentic legacy node-test manifest without official profile metadata", () => {
    const manifest = core.decideEvidence(campaign());
    assert.equal("profile" in manifest.evidenceContext.adapter.configuration, false);

    assert.deepEqual(core.replayEvidenceManifest(manifest), {
      valid: true,
      decisionDigestValid: true,
      artifactDigestValid: true,
      decisionSemanticsValid: true,
    });
  });

  it("rejects forged decision semantics even when both public digests are recomputed", () => {
    const input = campaign(["candidate-a"]);
    for (const run of input.observations) {
      if (run.candidateId === "candidate-a" && run.worldId.startsWith("target-")) {
        run.outcome = "COMPILE_FAILURE";
      }
    }
    const manifest = core.decideEvidence(input);
    manifest.candidates[0].status = "ELIGIBLE";
    manifest.candidates[0].reasonCodes = ["POLICY_SATISFIED"];
    manifest.decision = {
      status: "VERIFIED",
      selectedCandidateIds: ["candidate-a"],
      reasonCodes: ["POLICY_SATISFIED"],
    };
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

    const replay = core.replayEvidenceManifest(forged);
    assert.equal(replay.decisionDigestValid, true);
    assert.equal(replay.artifactDigestValid, true);
    assert.equal(replay.decisionSemanticsValid, false);
    assert.equal(replay.valid, false);
  });

  it("keeps semantic and decision replay valid when only duration is altered", () => {
    const manifest = core.decideEvidence(campaign());
    manifest.observations[0].durationMs += 1;

    const replay = core.replayEvidenceManifest(manifest);
    assert.equal(replay.decisionDigestValid, true);
    assert.equal(replay.artifactDigestValid, false);
    assert.equal(replay.decisionSemanticsValid, true);
    assert.equal(replay.valid, false);
  });

  it("rejects auto-sealed deterministic observation fields unknown to the core", () => {
    const manifest = core.decideEvidence(campaign());
    (manifest.observations[0] as any).deterministicExtra = "forged";
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

    const replay = core.replayEvidenceManifest(forged);
    assert.equal(replay.decisionDigestValid, true);
    assert.equal(replay.artifactDigestValid, true);
    assert.equal(replay.decisionSemanticsValid, false);
    assert.equal(replay.valid, false);
  });
});
