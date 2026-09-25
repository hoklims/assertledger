import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseVersionedVerificationRequest } from "../src/contracts/index.js";

function request(schemaVersion: string) {
  return {
    schemaVersion,
    repository: { root: ".", exclude: [] },
    adapter: {
      kind: "bun-test",
      executable: "bun",
      baseTestFiles: ["tests/base.test.ts"],
    },
    isolation: {
      kind: "trusted-local",
      acknowledgedUnsafeExecution: true,
      environmentAllowlist: [],
    },
    candidateRoots: ["tests/candidates"],
    budgets: {
      maximumCandidates: 1,
      maximumWorlds: 3,
      maximumExecutions: 6,
      maximumRepositoryFiles: 100,
      maximumRepositoryBytes: 1_000_000,
      maximumWorldOverlayBytes: 10_000,
      maximumCandidateBytes: 10_000,
      maximumTotalCandidateBytes: 10_000,
      timeoutMsPerExecution: 5_000,
      maximumOutputBytes: 65_536,
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 1,
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
        provenance: "fixture:reference",
        files: [],
      },
      {
        id: "target",
        kind: "TARGET",
        required: true,
        weight: 1,
        provenance: "fixture:target",
        files: [{ path: "src/subject.ts", content: "export const subject = false;\n" }],
      },
      {
        id: "neutral",
        kind: "NEUTRAL",
        required: true,
        weight: 0,
        provenance: "fixture:neutral",
        files: [],
      },
    ],
    candidates: [
      {
        id: "candidate",
        files: [{ path: "tests/candidates/candidate.test.ts", content: "" }],
      },
    ],
  };
}

describe("Bun adapter contract migration", () => {
  it("admits the built-in adapter only in verification request v3", () => {
    const parsed = parseVersionedVerificationRequest(request("3.0.0"));
    assert.equal(parsed.schemaVersion, "3.0.0");
    assert.equal(parsed.adapter.kind, "bun-test");
    for (const legacyVersion of ["1.0.0", "2.0.0"]) {
      assert.throws(
        () => parseVersionedVerificationRequest(request(legacyVersion)),
        /REQUEST_SCHEMA_INVALID/,
      );
    }
  });
});
