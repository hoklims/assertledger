import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseVerificationRequestV3,
  parseVerificationRequestV4,
  parseVersionedVerificationRequest,
} from "../src/contracts/index.js";

const IMAGE = "node@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43";
const LIMITS = {
  memoryBytes: 268_435_456,
  cpuMillicores: 1_000,
  pids: 64,
  temporaryDirectoryBytes: 16_777_216,
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "4.0.0",
    repository: { root: ".", exclude: [], includeDependencies: false, git: "excluded" },
    adapter: { kind: "bun-test-designated", executable: "bun", testTimeoutMs: null },
    isolation: {
      kind: "trusted-local",
      acknowledgedUnsafeExecution: true,
      environmentAllowlist: ["PATH"],
    },
    candidateRoots: ["tools/a.test.ts"],
    budgets: {
      maximumCandidates: 1,
      maximumWorlds: 3,
      maximumExecutions: 12,
      maximumRepositoryFiles: 100,
      maximumRepositoryBytes: 1_000_000,
      maximumWorldOverlayBytes: 10_000,
      maximumCandidateBytes: 1,
      maximumTotalCandidateBytes: 1,
      timeoutMsPerExecution: 10_000,
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
      { id: "reference", kind: "REFERENCE", required: true, weight: 0, provenance: "r", files: [] },
      {
        id: "target",
        kind: "TARGET",
        required: true,
        weight: 1,
        provenance: "t",
        files: [{ path: "src/a.ts", content: "export {};\n" }],
      },
      { id: "neutral", kind: "NEUTRAL", required: true, weight: 0, provenance: "n", files: [] },
    ],
    candidates: [
      {
        id: "designated",
        test: { file: "tools/a.test.ts", path: ["suite", "test"] },
        expectedFailure: null,
      },
    ],
    ...overrides,
  };
}

const fileCandidate = {
  id: "file",
  files: [{ path: "tools/a.test.ts", content: 'import { test } from "bun:test";\n' }],
};

describe("verification request v4", () => {
  it("accepts a designated campaign and routes 4.0.0 through the versioned parser", () => {
    assert.equal(parseVerificationRequestV4(request()).adapter.kind, "bun-test-designated");
    assert.equal(parseVersionedVerificationRequest(request()).schemaVersion, "4.0.0");
  });

  it("pairs designated candidates with the designated adapter only", () => {
    assert.throws(
      () =>
        parseVerificationRequestV4(
          request({
            adapter: { kind: "bun-test", executable: "bun", baseTestFiles: ["tools/b.test.ts"] },
          }),
        ),
      /DESIGNATED_CANDIDATE_ADAPTER_MISMATCH/u,
    );
    assert.throws(
      () =>
        parseVerificationRequestV4(
          request({
            candidates: [fileCandidate],
            budgets: {
              ...request().budgets,
              maximumCandidateBytes: 1_000,
              maximumTotalCandidateBytes: 1_000,
            },
          }),
        ),
      /DESIGNATED_CANDIDATE_REQUIRED/u,
    );
  });

  it("admits the designated adapter in a container and keeps refusing bun-test there", () => {
    const container = { kind: "container", image: IMAGE, environment: [], limits: LIMITS };
    assert.equal(
      parseVerificationRequestV4(request({ isolation: container })).isolation.kind,
      "container",
    );
    const bunTest = {
      adapter: { kind: "bun-test", executable: "bun", baseTestFiles: ["tools/b.test.ts"] },
      candidates: [fileCandidate],
      candidateRoots: ["tools"],
      isolation: container,
      budgets: {
        ...request().budgets,
        maximumCandidateBytes: 1_000,
        maximumTotalCandidateBytes: 1_000,
      },
    };
    assert.throws(
      () => parseVerificationRequestV4(request(bunTest)),
      /BUN_TEST_CONTAINER_UNSUPPORTED/u,
    );
    const { repository: _repository, ...v3 } = request(bunTest);
    assert.throws(
      () =>
        parseVerificationRequestV3({
          ...v3,
          schemaVersion: "3.0.0",
          repository: { root: ".", exclude: [] },
        }),
      /BUN_TEST_CONTAINER_UNSUPPORTED/u,
    );
  });

  it("requires an explicit Git mode and per-test timeout, the timeout below the execution's", () => {
    assert.throws(
      () =>
        parseVerificationRequestV4(
          request({ repository: { root: ".", exclude: [], includeDependencies: false } }),
        ),
      /REQUEST_SCHEMA_INVALID/u,
    );
    assert.throws(
      () =>
        parseVerificationRequestV4(
          request({ adapter: { kind: "bun-test-designated", executable: "bun" } }),
        ),
      /REQUEST_SCHEMA_INVALID/u,
    );
    assert.throws(
      () =>
        parseVerificationRequestV4(
          request({
            adapter: { kind: "bun-test-designated", executable: "bun", testTimeoutMs: 10_000 },
          }),
        ),
      /DESIGNATED_TEST_TIMEOUT_EXCEEDS_EXECUTION/u,
    );
    assert.equal(
      parseVerificationRequestV4(
        request({
          adapter: { kind: "bun-test-designated", executable: "bun", testTimeoutMs: 9_999 },
        }),
      ).adapter.kind,
      "bun-test-designated",
    );
  });

  it("declares Windows-native execution as its own isolation kind, never implied", () => {
    const parsed = parseVerificationRequestV4(
      request({
        isolation: {
          kind: "windows-native",
          acknowledgedUnsafeExecution: true,
          environmentAllowlist: ["PATH"],
        },
      }),
    );
    assert.equal(parsed.isolation.kind, "windows-native");
    assert.throws(() =>
      parseVersionedVerificationRequest({
        ...request({
          isolation: {
            kind: "windows-native",
            acknowledgedUnsafeExecution: true,
            environmentAllowlist: ["PATH"],
          },
        }),
        schemaVersion: "3.0.0",
      }),
    );
  });
});
