import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as contracts from "../src/contracts/index.js";
import * as core from "../src/core/index.js";
import { AssertLedger } from "../src/sdk/index.js";

const IMAGE = `node@sha256:${"a".repeat(64)}`;
const LIMITS = {
  memoryBytes: 1_073_741_824,
  cpuMillicores: 2_000,
  pids: 256,
  temporaryDirectoryBytes: 67_108_864,
};

function containerIsolation(overrides: Record<string, unknown> = {}) {
  return {
    kind: "container",
    image: IMAGE,
    environment: [{ name: "TZ", value: "UTC" }],
    limits: { ...LIMITS },
    ...overrides,
  };
}

function requestV2(isolation: unknown = containerIsolation()) {
  return {
    schemaVersion: "2.0.0",
    repository: { root: ".", exclude: [".git", "node_modules"] },
    adapter: { kind: "node-test", executable: "node", baseTestFiles: ["tests/base.test.js"] },
    isolation,
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
      timeoutMsPerExecution: 30_000,
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
        provenance: "git:a",
        files: [],
      },
      {
        id: "target",
        kind: "TARGET",
        required: true,
        weight: 1,
        provenance: "git:b",
        files: [{ path: "src/value.js", content: "export const value = 0;\n" }],
      },
      { id: "neutral", kind: "NEUTRAL", required: true, weight: 0, provenance: "git:c", files: [] },
    ],
    candidates: [
      {
        id: "candidate",
        files: [{ path: "tests/candidates/value.test.js", content: "// candidate\n" }],
      },
    ],
  };
}

function containerBackend(overrides: Record<string, unknown> = {}) {
  return {
    kind: "container",
    level: "CONTAINER",
    image: { reference: IMAGE, id: `sha256:${"b".repeat(64)}`, os: "linux", architecture: "amd64" },
    runtime: {
      clientVersion: "29.7.2",
      serverVersion: "29.7.2",
      serverOs: "linux",
      serverArchitecture: "amd64",
      cgroupVersion: "2",
      securityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"],
    },
    controls: {
      network: "none",
      rootFilesystem: "read-only",
      hostMounts: "none",
      workspace: "anonymous-volume",
      user: "65534:65534",
      capabilities: "none",
      noNewPrivileges: true,
      imagePull: "never",
      logDriver: "none",
      environment: [{ name: "TZ", value: "UTC" }],
      limits: { ...LIMITS },
    },
    ...overrides,
  };
}

const CONTAINER_SUMMARY = {
  kind: "container",
  level: "CONTAINER",
  runtimeCommand: ["docker"],
} as const;

function evidenceV2(
  backend: unknown = containerBackend(),
  level = "CONTAINER",
  environmentAllowlist = ["TZ"],
) {
  const worlds = [
    { id: "reference", kind: "REFERENCE", required: true, weight: 0 },
    { id: "target", kind: "TARGET", required: true, weight: 1 },
    { id: "neutral", kind: "NEUTRAL", required: true, weight: 0 },
  ] as const;
  const observations = worlds.flatMap((world) =>
    [1, 2].flatMap((attempt) => [
      {
        runId: `control:${world.id}:${attempt}`,
        candidateId: null,
        worldId: world.id,
        attempt,
        outcome: "PASS",
        testsDiscovered: 1,
        candidateTestsDiscovered: 0,
        attributed: false,
      },
      {
        runId: `candidate:${world.id}:${attempt}`,
        candidateId: "candidate",
        worldId: world.id,
        attempt,
        outcome: world.kind === "TARGET" ? "ASSERTION_FAILURE" : "PASS",
        testsDiscovered: 2,
        candidateTestsDiscovered: 1,
        attributed: true,
      },
    ]),
  );
  return {
    schemaVersion: "2.0.0",
    repositoryDigest: core.sha256Canonical({ label: "repository" }),
    evidenceContext: {
      engine: { name: "testforge", version: "0.1.0" },
      adapter: { name: "node-test", version: "24.19.0", configuration: { kind: "node-test" } },
      execution: {
        isolation: level,
        environmentAllowlist,
        budgets: {},
        candidateRoots: ["tests"],
        backend,
      },
      worlds: worlds.map((world) => ({
        id: world.id,
        provenance: `fixture:${world.id}`,
        digest: core.sha256Canonical({ label: world.id }),
      })),
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 2,
      minimumTargetWeightPermille: 1_000,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds,
    candidates: [
      { id: "candidate", digest: core.sha256Canonical({ label: "candidate" }), sizeBytes: 12 },
    ],
    observations,
  };
}

function sealV2(decided: unknown, isolation: unknown = CONTAINER_SUMMARY): any {
  return core.sealManifestArtifact({
    ...(decided as Record<string, unknown>),
    adapter: { kind: "node-test" },
    isolation,
    limitations: ["Container fixture."],
  });
}

function containerManifest(backend: unknown = containerBackend()) {
  return sealV2(core.decideEvidence(evidenceV2(backend)));
}

describe("verification request v2", () => {
  it("accepts container isolation with a digest-pinned image and explicit limits", () => {
    const parsed = contracts.parseVersionedVerificationRequest(requestV2());
    assert.equal(parsed.schemaVersion, "2.0.0");
    assert.deepEqual(parsed.isolation, containerIsolation());
  });

  it("keeps trusted-local available in v2 as an explicitly acknowledged unsandboxed mode", () => {
    const isolation = {
      kind: "trusted-local",
      acknowledgedUnsafeExecution: true,
      environmentAllowlist: ["PATH"],
    };
    assert.deepEqual(
      contracts.parseVersionedVerificationRequest(requestV2(isolation)).isolation,
      isolation,
    );
  });

  it("rejects container isolation in the frozen v1 request contract", () => {
    assert.throws(
      () => contracts.parseVersionedVerificationRequest({ ...requestV2(), schemaVersion: "1.0.0" }),
      /REQUEST_SCHEMA_INVALID/,
    );
    assert.throws(
      () => contracts.parseVerificationRequest(requestV2()),
      /SCHEMA_VERSION_UNSUPPORTED/,
    );
  });

  it("rejects mutable, flag-like or malformed image references", () => {
    for (const image of [
      "node:24-alpine",
      `node@sha256:${"a".repeat(63)}`,
      `node@sha256:${"A".repeat(64)}`,
      `-node@sha256:${"a".repeat(64)}`,
      ` node@sha256:${"a".repeat(64)}`,
      `node@sha256:${"a".repeat(64)}\n`,
      `--privileged@sha256:${"a".repeat(64)}`,
    ]) {
      assert.throws(
        () => contracts.parseVersionedVerificationRequest(requestV2(containerIsolation({ image }))),
        /REQUEST_SCHEMA_INVALID/,
        image,
      );
    }
  });

  it("does not let a request choose the host runtime command or forward host variables", () => {
    for (const extra of [
      { runtime: { command: ["rm", "-rf", "/"] } },
      { runtimeCommand: ["docker"] },
      { environmentAllowlist: ["PATH"] },
      { acknowledgedUnsafeExecution: true },
    ]) {
      assert.throws(
        () => contracts.parseVersionedVerificationRequest(requestV2(containerIsolation(extra))),
        /REQUEST_SCHEMA_INVALID/,
        JSON.stringify(extra),
      );
    }
  });

  it("rejects reserved and duplicate container environment variables", () => {
    for (const name of ["NODE_OPTIONS", "TESTFORGE_RESULT_FILE", "node_test_context"]) {
      assert.throws(
        () =>
          contracts.parseVersionedVerificationRequest(
            requestV2(containerIsolation({ environment: [{ name, value: "x" }] })),
          ),
        /RESERVED_ENVIRONMENT_VARIABLE/,
        name,
      );
    }
    assert.throws(
      () =>
        contracts.parseVersionedVerificationRequest(
          requestV2(
            containerIsolation({
              environment: [
                { name: "TZ", value: "UTC" },
                { name: "TZ", value: "Europe/Paris" },
              ],
            }),
          ),
        ),
      /DUPLICATE_CONTAINER_ENVIRONMENT_VARIABLE/,
    );
  });

  it("bounds container resource limits", () => {
    for (const limits of [
      { ...LIMITS, memoryBytes: 1_024 },
      { ...LIMITS, cpuMillicores: 10 },
      { ...LIMITS, pids: 0 },
      { ...LIMITS, temporaryDirectoryBytes: 2 ** 40 },
      { memoryBytes: LIMITS.memoryBytes, cpuMillicores: 2_000, pids: 256 },
    ]) {
      assert.throws(
        () =>
          contracts.parseVersionedVerificationRequest(requestV2(containerIsolation({ limits }))),
        /REQUEST_SCHEMA_INVALID/,
        JSON.stringify(limits),
      );
    }
  });
});

describe("evidence manifest v2", () => {
  it("binds the container backend record to the decision digest", () => {
    const manifest = containerManifest();
    assert.equal(manifest.schemaVersion, "2.0.0");
    assert.equal(manifest.decision.status, "VERIFIED");
    assert.deepEqual(manifest.evidenceContext.execution.backend, containerBackend());
    assert.deepEqual(contracts.parseEvidenceManifestV2(manifest), manifest);

    const otherImage = containerManifest(
      containerBackend({
        image: {
          reference: IMAGE,
          id: `sha256:${"c".repeat(64)}`,
          os: "linux",
          architecture: "amd64",
        },
      }),
    );
    assert.notEqual(otherImage.decisionDigest, manifest.decisionDigest);
  });

  it("replays container manifests and detects backend and invocation tampering", () => {
    const ledger = new AssertLedger();
    const manifest = containerManifest();
    assert.deepEqual(ledger.replay(manifest), {
      valid: true,
      schemaValid: true,
      decisionDigestValid: true,
      artifactDigestValid: true,
      decisionSemanticsValid: true,
    });

    const tamperedBackend = structuredClone(manifest);
    tamperedBackend.evidenceContext.execution.backend.controls.network = "bridge";
    assert.equal(ledger.replay(tamperedBackend).valid, false);

    const tamperedImage = structuredClone(manifest);
    tamperedImage.evidenceContext.execution.backend.image.id = `sha256:${"d".repeat(64)}`;
    const imageReplay = ledger.replay(tamperedImage);
    assert.equal(imageReplay.schemaValid, true);
    assert.equal(imageReplay.decisionDigestValid, false);
    assert.equal(imageReplay.valid, false);

    const tamperedCommand = structuredClone(manifest);
    tamperedCommand.isolation.runtimeCommand = ["podman"];
    const commandReplay = ledger.replay(tamperedCommand);
    assert.equal(commandReplay.decisionDigestValid, true);
    assert.equal(commandReplay.artifactDigestValid, false);
    assert.equal(commandReplay.valid, false);
  });

  it("records an explicitly acknowledged unsandboxed backend in v2", () => {
    const manifest = sealV2(
      core.decideEvidence(
        evidenceV2({ kind: "trusted-local", level: "UNSANDBOXED" }, "UNSANDBOXED", ["PATH"]),
      ),
      { kind: "trusted-local", level: "UNSANDBOXED", acknowledgedUnsafeExecution: true },
    );
    assert.equal(contracts.parseEvidenceManifestV2(manifest).isolation.kind, "trusted-local");
    assert.equal(new AssertLedger().replay(manifest).valid, true);
  });

  it("refuses v2 evidence without a backend record", () => {
    const evidence = evidenceV2();
    delete (evidence.evidenceContext.execution as { backend?: unknown }).backend;
    const manifest = core.decideEvidence(evidence);
    assert.equal(manifest.decision.status, "ENGINE_ERROR");
    assert.deepEqual(manifest.decision.reasonCodes, ["EVIDENCE_INPUT_INVALID"]);
  });

  it("rejects isolation summaries that disagree with the backend record", () => {
    const cases = [
      sealV2(core.decideEvidence(evidenceV2()), {
        kind: "trusted-local",
        level: "UNSANDBOXED",
        acknowledgedUnsafeExecution: true,
      }),
      sealV2(core.decideEvidence(evidenceV2(containerBackend(), "UNSANDBOXED"))),
      sealV2(core.decideEvidence(evidenceV2(containerBackend(), "CONTAINER", ["PATH"]))),
      sealV2(core.decideEvidence(evidenceV2(containerBackend(), "CONTAINER", []))),
    ];
    for (const manifest of cases) {
      assert.throws(() => contracts.parseEvidenceManifestV2(manifest), /EVIDENCE_MANIFEST_/);
      assert.equal(new AssertLedger().replay(manifest).schemaValid, false);
    }
  });

  it("keeps the frozen v1 parsers and derived v1 consumers closed to v2 manifests", () => {
    const manifest = containerManifest();
    assert.throws(() => contracts.parseEvidenceManifest(manifest), /EVIDENCE_MANIFEST_INVALID/);
    assert.throws(
      () =>
        new AssertLedger().exportEvidence({
          schemaVersion: "1.0.0",
          manifest,
          consumerRequest: null,
        }),
      /EVIDENCE_EXPORT_REQUEST_INVALID/,
    );
  });

  it("publishes versioned v2 JSON schemas without a request-owned runtime command", () => {
    const ledger = new AssertLedger();
    const request = ledger.schema("verification-request-v2");
    const manifest = ledger.schema("evidence-manifest-v2");
    assert.equal(request.$id, "https://testforge.dev/schemas/verification-request.v2.json");
    assert.equal(manifest.$id, "https://testforge.dev/schemas/evidence-manifest.v2.json");
    assert.doesNotMatch(JSON.stringify(request), /runtimeCommand|"runtime"/);
    assert.match(JSON.stringify(manifest), /runtimeCommand/);
    assert.deepEqual(
      ledger.schema("verification-request"),
      contracts.verificationRequestJsonSchema(),
    );
  });
});
