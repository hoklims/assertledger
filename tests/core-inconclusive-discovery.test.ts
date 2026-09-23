import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideEvidence,
  replayEvidenceManifest,
  sealManifestArtifact,
  sha256Canonical,
  verifyDecisionDigest,
} from "../src/core/index.js";

// Kept out of tests/core.test.ts, whose literal test list is a frozen self-hosted benchmark input.

type Observation = {
  runId: string;
  candidateId: string | null;
  worldId: string;
  attempt: number;
  outcome: string;
  testsDiscovered: number;
  candidateTestsDiscovered: number;
  attributed: boolean;
  durationMs: number;
  exitCode: number | null;
  stdoutDigest: string;
  stderrDigest: string;
};

const WORLDS = [
  { id: "reference", kind: "REFERENCE", required: true, weight: 0 },
  { id: "target-off-by-one", kind: "TARGET", required: true, weight: 3 },
  { id: "target-overflow", kind: "TARGET", required: false, weight: 2 },
  { id: "neutral-refactor", kind: "NEUTRAL", required: true, weight: 0 },
] as const;

function fixtureDigest(label: string): string {
  return sha256Canonical({ fixture: label });
}

function observation(
  candidateId: string | null,
  worldId: string,
  attempt: number,
  outcome: string,
): Observation {
  return {
    runId: `${candidateId ?? "control"}:${worldId}:${attempt}`,
    candidateId,
    worldId,
    attempt,
    outcome,
    testsDiscovered: candidateId === null ? 1 : 2,
    candidateTestsDiscovered: candidateId === null ? 0 : 1,
    attributed: candidateId !== null,
    durationMs: 17 + attempt,
    exitCode: outcome === "PASS" ? 0 : 1,
    stdoutDigest: fixtureDigest(`stdout:${candidateId ?? "control"}:${worldId}:${attempt}`),
    stderrDigest: fixtureDigest(`stderr:${candidateId ?? "control"}:${worldId}:${attempt}`),
  };
}

/** candidate-a kills both targets; candidate-b kills the required one only. */
function campaign(candidateIds: string[]) {
  const observations = WORLDS.flatMap((world) => [
    observation(null, world.id, 1, "PASS"),
    observation(null, world.id, 2, "PASS"),
  ]);
  for (const candidateId of candidateIds) {
    for (const world of WORLDS) {
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
        // Literals, not the host's Node: the core never runs the adapter, and the pinned digests
        // below must be the same on every machine.
        name: "node-test",
        version: "22.0.0",
        configuration: { executable: "/usr/bin/node", arguments: ["--test"] },
      },
      execution: {
        isolation: "UNSANDBOXED",
        environmentAllowlist: ["PATH", "SystemRoot"],
        budgets: { timeoutMsPerExecution: 5_000, maximumOutputBytes: 65_536 },
        candidateRoots: ["tests/candidates"],
      },
      worlds: WORLDS.map((world) => ({
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
    worlds: WORLDS.map((world) => ({ ...world })),
    candidates: candidateIds.map((id) => ({
      id,
      digest: fixtureDigest(`candidate:${id}`),
      sizeBytes: id === "candidate-a" ? 200 : 100,
    })),
    observations,
  };
}

/**
 * The shape the engine really reports for TIMEOUT and INFRA_ERROR: the run never reached a
 * verdict, so no candidate test is discovered or attributed.
 */
function asEngineReports(
  input: ReturnType<typeof campaign>,
  candidateId: string,
  worldIds: readonly string[],
  outcome: "TIMEOUT" | "INFRA_ERROR",
) {
  for (const run of input.observations) {
    if (run.candidateId === candidateId && worldIds.includes(run.worldId)) {
      Object.assign(run, {
        outcome,
        testsDiscovered: 0,
        candidateTestsDiscovered: 0,
        attributed: false,
        exitCode: null,
      });
    }
  }
  return input;
}

/**
 * Decision digests these inputs had on main before this change (8a218de), produced by running
 * this file's fixtures against that core: the change must leave every manifest outside its own
 * case byte-identical.
 */
const DIGESTS_BEFORE_CHANGE: Record<string, string> = {
  "mixed-discovery-failure-TIMEOUT":
    "sha256:a2ea83df33d42acd49f1b751833654f87ffd1ffd505f82e9f88c90e0c3a35d0f",
  "mixed-discovery-failure-INFRA_ERROR":
    "sha256:32a86bba8bb649cd44b7a43996db6238300ffca37c39ddd450c18dba6a77cb0a",
  "conclusive-COMPILE_FAILURE":
    "sha256:881acf56a31331cd16722cd0941ec82fdee452be82e4448af1f0f0ed77fd26ad",
  "conclusive-COLLECTION_FAILURE":
    "sha256:60bb06ae847943399b7e0fe28e8403c058ea8c1b1bb2c303b732d817bac494ae",
  "conclusive-PROCESS_CRASH":
    "sha256:da0495c77c1e34c7f29a13a610f32c39aa993131fb771f22bd31f20042c7d4c3",
  "no-test-discovered": "sha256:310fa428a845b4c0a3e594029c646b3e17df5e1e5520a9a81fdbf780c1d32d3a",
  "diverging-timeout": "sha256:4dc962a7098297fbb15535477b4f6b946472aeb476364e5fe9debfc4a2d2d622",
  "control-timeout": "sha256:6659cc2ac6d56ff225582d09076e7062d50508657995f806b06a883622fe6f98",
  "verified-with-hung-neighbour":
    "sha256:44fda235affc1b5f6e6c60877eb1c471840c95cd492e38ad7386c697c606db3b",
  "attributed-timeout": "sha256:99f45483985190c6b1ac3e999b8957d53d5253f357c9eda3578cb017b5a4c94b",
};
/** Artifact digest main sealed for the verified campaign with a hung neighbour (8a218de). */
const ARTIFACT_DIGEST_BEFORE_CHANGE =
  "sha256:e89848427cf21908bb8bd49394a069a7218e24a80eee6fc9f237dd92fd55fa91";

function assertUnchanged(manifest: { decisionDigest: string }, key: string): void {
  assert.equal(manifest.decisionDigest, DIGESTS_BEFORE_CHANGE[key], key);
}

const gate = (candidate: { gates: { name: string }[] }, name: string) =>
  candidate.gates.find((entry) => entry.name === name) as
    | { name: string; status: string; reasonCodes: string[]; evidenceRunIds: string[] }
    | undefined;

describe("inconclusive execution before discovery", () => {
  for (const outcome of ["TIMEOUT", "INFRA_ERROR"] as const) {
    it(`classifies unattributed ${outcome} target runs as inconclusive, not invalid`, () => {
      const manifest = decideEvidence(
        asEngineReports(campaign(["candidate-a"]), "candidate-a", ["target-off-by-one"], outcome),
      );

      const candidate = manifest.candidates[0];
      assert.ok(candidate);
      assert.equal(candidate.status, "INCONCLUSIVE");
      assert.deepEqual(candidate.reasonCodes, ["CANDIDATE_EXECUTION_INCONCLUSIVE"]);
      assert.deepEqual(candidate.killedTargetIds, []);
      assert.equal(candidate.targetWeightKilled, 0);
      assert.deepEqual(
        candidate.gates.map((entry) => [entry.name, entry.status]),
        [
          ["COMPLETENESS", "PASSED"],
          ["STABILITY", "PASSED"],
          ["DISCOVERY", "FAILED"],
          ["REFERENCE", "NOT_RUN"],
          ["NEUTRAL", "NOT_RUN"],
          ["TARGET_STRENGTH", "NOT_RUN"],
        ],
      );
      assert.deepEqual(gate(candidate, "DISCOVERY")?.reasonCodes, [
        "CANDIDATE_EXECUTION_INCONCLUSIVE",
      ]);
      assert.equal(manifest.decision.status, "INCONCLUSIVE");
      assert.deepEqual(manifest.decision.reasonCodes, ["CANDIDATE_EVIDENCE_INCONCLUSIVE"]);
      assert.deepEqual(manifest.decision.selectedCandidateIds, []);
      assert.equal(replayEvidenceManifest(manifest).valid, true);
    });
  }

  it("classifies a candidate that hangs on every world as inconclusive", () => {
    const manifest = decideEvidence(
      asEngineReports(
        campaign(["candidate-a"]),
        "candidate-a",
        WORLDS.map((world) => world.id),
        "TIMEOUT",
      ),
    );

    assert.equal(manifest.candidates[0]?.status, "INCONCLUSIVE");
    assert.equal(manifest.decision.status, "INCONCLUSIVE");
    assert.deepEqual(manifest.decision.reasonCodes, ["CANDIDATE_EVIDENCE_INCONCLUSIVE"]);
  });

  it("does not let an unattributed timeout poison an independently eligible selection", () => {
    const manifest = decideEvidence(
      asEngineReports(
        campaign(["candidate-a", "candidate-b"]),
        "candidate-b",
        ["target-off-by-one", "target-overflow"],
        "TIMEOUT",
      ),
    );

    assert.equal(
      manifest.candidates.find((candidate) => candidate.id === "candidate-b")?.status,
      "INCONCLUSIVE",
    );
    assert.equal(manifest.decision.status, "VERIFIED");
    assert.deepEqual(manifest.decision.selectedCandidateIds, ["candidate-a"]);
    assert.deepEqual(manifest.decision.reasonCodes, ["POLICY_SATISFIED"]);
  });

  it("lets inconclusive execution take precedence over a red reference, as it already did", () => {
    const input = asEngineReports(
      campaign(["candidate-a"]),
      "candidate-a",
      ["target-off-by-one"],
      "TIMEOUT",
    );
    for (const run of input.observations) {
      if (run.candidateId === "candidate-a" && run.worldId === "reference") {
        run.outcome = "ASSERTION_FAILURE";
      }
    }

    const manifest = decideEvidence(input);

    const candidate = manifest.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.status, "INCONCLUSIVE");
    assert.deepEqual(candidate.reasonCodes, ["CANDIDATE_EXECUTION_INCONCLUSIVE"]);
    // Discovery is not established, so the dependent gates are not run and nothing is killed.
    assert.equal(gate(candidate, "REFERENCE")?.status, "NOT_RUN");
    assert.deepEqual(candidate.killedTargetIds, []);
    assert.equal(manifest.decision.status, "INCONCLUSIVE");
  });
});

describe("replay compatibility of manifests sealed before this change", () => {
  it("fails only decision semantics, even for a campaign that stays verified", () => {
    const input = asEngineReports(
      campaign(["candidate-a", "candidate-b"]),
      "candidate-b",
      ["target-off-by-one", "target-overflow"],
      "TIMEOUT",
    );
    const current = decideEvidence(input);
    assert.equal(current.decision.status, "VERIFIED");

    // Rebuild the manifest main sealed for the same observations: candidate-b invalid by discovery.
    const { artifactDigest: _artifact, ...before } = structuredClone(current);
    const hung = before.candidates.find((candidate) => candidate.id === "candidate-b");
    assert.ok(hung);
    hung.status = "INVALID";
    hung.reasonCodes = ["CANDIDATE_DISCOVERY_INVALID"];
    const discovery = gate(hung, "DISCOVERY");
    assert.ok(discovery);
    discovery.reasonCodes = ["CANDIDATE_DISCOVERY_INVALID"];
    const sealed = sealManifestArtifact({
      ...before,
      decisionDigest: DIGESTS_BEFORE_CHANGE["verified-with-hung-neighbour"] as string,
    });
    // The reconstruction is exactly what main sealed: both of its digests match main's.
    assert.equal(verifyDecisionDigest(sealed).valid, true);
    assert.equal(sealed.artifactDigest, ARTIFACT_DIGEST_BEFORE_CHANGE);

    const replay = replayEvidenceManifest(sealed);
    assert.equal(replay.decisionDigestValid, true);
    assert.equal(replay.artifactDigestValid, true);
    assert.equal(replay.decisionSemanticsValid, false);
    assert.equal(replay.valid, false);
    assert.notEqual(current.decisionDigest, sealed.decisionDigest);
  });
});

describe("verdicts the inconclusive classification must not change", () => {
  for (const outcome of ["TIMEOUT", "INFRA_ERROR"] as const) {
    it(`keeps a candidate invalid when a completed run disproves discovery beside ${outcome}`, () => {
      const input = asEngineReports(
        campaign(["candidate-a"]),
        "candidate-a",
        ["target-off-by-one"],
        outcome,
      );
      for (const run of input.observations) {
        if (run.candidateId === "candidate-a" && run.worldId === "reference") {
          Object.assign(run, { candidateTestsDiscovered: 0, attributed: false });
        }
      }

      const manifest = decideEvidence(input);

      const candidate = manifest.candidates[0];
      assert.ok(candidate);
      assert.equal(candidate.status, "INVALID");
      assert.deepEqual(candidate.reasonCodes, ["CANDIDATE_DISCOVERY_INVALID"]);
      assert.deepEqual(gate(candidate, "DISCOVERY")?.reasonCodes, ["CANDIDATE_DISCOVERY_INVALID"]);
      assert.equal(manifest.decision.status, "REJECTED");
      assert.deepEqual(manifest.decision.reasonCodes, ["NO_ELIGIBLE_CANDIDATE"]);
      assertUnchanged(manifest, `mixed-discovery-failure-${outcome}`);
    });
  }

  for (const outcome of ["COMPILE_FAILURE", "COLLECTION_FAILURE", "PROCESS_CRASH"] as const) {
    it(`keeps a candidate invalid when a target run ends in unattributed ${outcome}`, () => {
      const input = campaign(["candidate-a"]);
      for (const run of input.observations) {
        if (run.candidateId === "candidate-a" && run.worldId === "target-off-by-one") {
          Object.assign(run, { outcome, attributed: false });
        }
      }

      const manifest = decideEvidence(input);

      assert.equal(manifest.candidates[0]?.status, "INVALID");
      assert.deepEqual(manifest.candidates[0]?.reasonCodes, ["CANDIDATE_DISCOVERY_INVALID"]);
      assert.equal(manifest.decision.status, "REJECTED");
      assertUnchanged(manifest, `conclusive-${outcome}`);
    });
  }

  it("keeps a candidate that discovers no test invalid", () => {
    const input = campaign(["candidate-a"]);
    for (const run of input.observations) {
      if (run.candidateId === "candidate-a") {
        Object.assign(run, {
          outcome: "NO_TEST_DISCOVERED",
          testsDiscovered: 1,
          candidateTestsDiscovered: 0,
          attributed: false,
        });
      }
    }

    const manifest = decideEvidence(input);

    assert.equal(manifest.candidates[0]?.status, "INVALID");
    assert.equal(manifest.decision.status, "REJECTED");
    assertUnchanged(manifest, "no-test-discovered");
  });

  it("keeps diverging timeouts unstable", () => {
    const input = campaign(["candidate-a"]);
    const hung = input.observations.find(
      (run) =>
        run.candidateId === "candidate-a" &&
        run.worldId === "target-off-by-one" &&
        run.attempt === 1,
    );
    assert.ok(hung);
    Object.assign(hung, {
      outcome: "TIMEOUT",
      testsDiscovered: 0,
      candidateTestsDiscovered: 0,
      attributed: false,
    });

    const manifest = decideEvidence(input);

    assert.equal(manifest.candidates[0]?.status, "UNSTABLE");
    assert.equal(manifest.decision.status, "INCONCLUSIVE");
    assertUnchanged(manifest, "diverging-timeout");
  });

  it("keeps a timed-out control an invalid control, not a candidate verdict", () => {
    const input = campaign(["candidate-a"]);
    for (const run of input.observations) {
      if (run.candidateId === null && run.worldId === "target-off-by-one") {
        Object.assign(run, { outcome: "TIMEOUT", testsDiscovered: 0 });
      }
    }

    const manifest = decideEvidence(input);

    assert.equal(manifest.candidates[0]?.status, "ELIGIBLE");
    assert.equal(manifest.decision.status, "INCONCLUSIVE");
    assert.deepEqual(manifest.decision.reasonCodes, ["CONTROL_EVIDENCE_INVALID"]);
    assertUnchanged(manifest, "control-timeout");
  });

  it("keeps the manifest byte-identical when inconclusive runs pass discovery", () => {
    // The synthetic attributed shape already reached the INCONCLUSIVE branch; pin its digest so
    // the reordering cannot move it.
    const input = campaign(["candidate-a"]);
    for (const run of input.observations) {
      if (run.candidateId === "candidate-a" && run.worldId === "target-off-by-one") {
        run.outcome = "TIMEOUT";
      }
    }

    const manifest = decideEvidence(input);

    assert.equal(manifest.candidates[0]?.status, "INCONCLUSIVE");
    assert.equal(gate(manifest.candidates[0] as never, "DISCOVERY")?.status, "PASSED");
    assert.equal(gate(manifest.candidates[0] as never, "TARGET_STRENGTH")?.status, "FAILED");
    assertUnchanged(manifest, "attributed-timeout");
  });
});
