#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgenticBenchmark,
  createAgenticProfile,
  decideEvidence,
  replayAgenticBenchmark,
  replayEvidenceManifest,
  sealManifestArtifact,
  sha256Canonical,
} from "../src/index.js";
import { publishedSchemas } from "./schema-registry.js";

const SCHEMA_VERSION = "1.0.0" as const;
const CANONICAL_DIRECTORY = path.resolve("conformance", "v1");

function digest(label: string): string {
  return sha256Canonical({ label });
}

function evidenceInput(targetOutcome: string = "ASSERTION_FAILURE") {
  const worlds = [
    { id: "reference", kind: "REFERENCE" as const, required: true, weight: 0 },
    { id: "target", kind: "TARGET" as const, required: true, weight: 10 },
    { id: "neutral", kind: "NEUTRAL" as const, required: true, weight: 0 },
  ];
  return {
    schemaVersion: SCHEMA_VERSION,
    repositoryDigest: digest("repository"),
    evidenceContext: {
      engine: { name: "testforge", version: "0.1.0" },
      adapter: {
        name: "node-test",
        version: "22.0.0",
        configuration: { kind: "node-test", executable: "node" },
      },
      execution: {
        isolation: "UNSANDBOXED",
        environmentAllowlist: [],
        budgets: {},
        candidateRoots: ["tests"],
      },
      worlds: worlds.map((world) => ({
        id: world.id,
        provenance: `conformance:${world.id}`,
        digest: digest(world.id),
      })),
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 1,
      minimumTargetWeightPermille: 1_000,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds,
    candidates: [{ id: "candidate", digest: digest("candidate"), sizeBytes: 100 }],
    observations: worlds.flatMap((world) => [
      {
        runId: `control:${world.id}:1`,
        candidateId: null,
        worldId: world.id,
        attempt: 1,
        outcome: "PASS",
        testsDiscovered: 1,
        candidateTestsDiscovered: 0,
        attributed: false,
        durationMs: 1,
      },
      {
        runId: `candidate:${world.id}:1`,
        candidateId: "candidate",
        worldId: world.id,
        attempt: 1,
        outcome: world.kind === "TARGET" ? targetOutcome : "PASS",
        testsDiscovered: 2,
        candidateTestsDiscovered: 1,
        attributed: true,
        durationMs: world.kind === "REFERENCE" ? 10 : 1,
      },
    ]),
  };
}

function sealedVerifiedManifest() {
  const manifest = decideEvidence(evidenceInput());
  return sealManifestArtifact({
    ...manifest,
    adapter: { kind: "node-test" as const },
    isolation: {
      kind: "trusted-local" as const,
      level: "UNSANDBOXED" as const,
      acknowledgedUnsafeExecution: true as const,
    },
    limitations: ["Static conformance fixture; not execution truth."],
  });
}

function profileRequest() {
  return {
    schemaVersion: SCHEMA_VERSION,
    manifest: sealedVerifiedManifest(),
    policy: {
      profileVersion: "1.0.0" as const,
      profileId: "conformance/default",
      mode: "HARDENING" as const,
      minimumTimingSamples: 1,
      lanes: [{ id: "instant", maximumReferenceP95Ms: 20 }],
    },
  };
}

function completeRun(
  candidateDigest: string,
  regime: "COLD" | "WARM",
  role: "WARMUP" | "MEASUREMENT",
  ordinal: number,
  totalUs: number,
) {
  return {
    candidateId: "candidate",
    candidateDigest,
    regime,
    role,
    ordinal,
    status: "COMPLETE" as const,
    outcome: "PASS" as const,
    phases: [
      { phase: "PREPARATION" as const, durationUs: 1 },
      { phase: "STARTUP" as const, durationUs: 1 },
      { phase: "COMPILE_OR_COLLECTION" as const, durationUs: 1 },
      { phase: "EXECUTION" as const, durationUs: totalUs - 3 },
    ],
    totalUs,
  };
}

function benchmarkRequest() {
  const sourceManifest = sealedVerifiedManifest();
  const candidateDigest = sourceManifest.candidates[0]?.digest;
  if (candidateDigest === undefined) throw new Error("CONFORMANCE_CANDIDATE_MISSING");
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceManifest,
    referenceWorldId: "reference",
    policy: {
      benchmarkVersion: "1.0.0" as const,
      minimumMeasuredSamplesPerRegime: 3,
      coldMeasuredSamples: 3,
      warmupSamples: 1,
      warmMeasuredSamples: 3,
      maximumExecutions: 7,
    },
    protocol: {
      protocolVersion: "1.0.0" as const,
      clock: "MONOTONIC" as const,
      unit: "MICROSECOND" as const,
      quantile: "NEAREST_RANK" as const,
      phases: ["PREPARATION", "STARTUP", "COMPILE_OR_COLLECTION", "EXECUTION"] as const,
      coldDefinition: "FRESH_WORKSPACE_FRESH_PROCESS_RESET_DECLARED_CACHES" as const,
      warmDefinition: "FRESH_WORKSPACE_FRESH_PROCESS_RETAIN_DECLARED_CACHES" as const,
    },
    fingerprint: {
      environmentId: "conformance-environment",
      os: { platform: "win32", release: "conformance", arch: "x64" },
      cpu: { arch: "x64", model: "conformance-cpu", logicalCores: 4 },
      logicalCpuLimit: null,
      memoryLimitBytes: null,
      executionBoundary: "UNSANDBOXED" as const,
      tools: [
        {
          role: "runtime",
          name: "node",
          version: "22.0.0",
          digest: digest("runtime"),
          configurationDigest: digest("runtime-configuration"),
        },
      ],
      dependencyGraphDigest: digest("dependency-graph"),
      phaseReporterDigest: digest("phase-reporter"),
    },
    runs: [
      ...[10, 20, 30].map((value, index) =>
        completeRun(candidateDigest, "COLD", "MEASUREMENT", index + 1, value),
      ),
      completeRun(candidateDigest, "WARM", "WARMUP", 1, 40),
      ...[50, 60, 70].map((value, index) =>
        completeRun(candidateDigest, "WARM", "MEASUREMENT", index + 1, value),
      ),
    ],
  };
}

function decisionDigestProjection(manifest: ReturnType<typeof decideEvidence>) {
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

async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
  const destination = path.join(root, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function schemaExpectedDigests() {
  const schemaDirectory = path.resolve("schemas");
  const names = publishedSchemas()
    .map(([name]) => name)
    .sort();
  const schemas = [];
  for (const name of names) {
    const bytes = await readFile(path.join(schemaDirectory, name));
    const parsed = JSON.parse(bytes.toString("utf8")) as { $id?: unknown };
    if (typeof parsed.$id !== "string") throw new Error(`SCHEMA_ID_MISSING: ${name}`);
    schemas.push({
      path: `schemas/${name}`,
      rawSha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      $id: parsed.$id,
    });
  }
  return { schemaVersion: SCHEMA_VERSION, schemas };
}

async function main(argv: string[]): Promise<void> {
  const outputIndex = argv.indexOf("--output-dir");
  const outputArgument = outputIndex === -1 ? undefined : argv[outputIndex + 1];
  if (outputArgument === undefined) throw new Error("OUTPUT_DIRECTORY_REQUIRED");
  const outputDirectory = path.resolve(outputArgument);
  if (outputDirectory === CANONICAL_DIRECTORY && !argv.includes("--maintainer-allow-canonical")) {
    throw new Error("CANONICAL_CONFORMANCE_WRITE_FORBIDDEN");
  }
  if (
    outputDirectory === path.parse(outputDirectory).root ||
    outputDirectory === path.resolve(".")
  ) {
    throw new Error("OUTPUT_DIRECTORY_UNSAFE");
  }
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });

  const cases: Array<{
    id: string;
    operation: string;
    inputPath: string;
    expectedPath: string;
    outcome: "GREEN" | "RED";
  }> = [];
  const add = async (
    id: string,
    operation: string,
    input: unknown,
    expected: unknown,
    outcome: "GREEN" | "RED",
  ) => {
    const inputPath = `inputs/${id}.json`;
    const expectedPath = `expected/${id}.json`;
    await writeJson(outputDirectory, inputPath, input);
    await writeJson(outputDirectory, expectedPath, expected);
    cases.push({ id, operation, inputPath, expectedPath, outcome });
  };

  const canonicalA = { z: 1, nested: { b: true, a: [3, 2, 1] }, a: "value" };
  const canonicalB = { a: "value", nested: { a: [3, 2, 1], b: true }, z: 1 };
  const canonicalExpected = {
    canonical: '{"a":"value","nested":{"a":[3,2,1],"b":true},"z":1}',
    digest: "sha256:7cb0873c19c99b87bf7d6679928296bf68fdf53e20ca63c50bb8969f13c1056d",
  };
  await add("canonical-order-a", "CANONICALIZE", canonicalA, canonicalExpected, "GREEN");
  await add("canonical-order-b", "CANONICALIZE", canonicalB, canonicalExpected, "GREEN");

  const verifiedInput = evidenceInput();
  const verified = decideEvidence(verifiedInput);
  await add("decide-verified", "DECIDE_EVIDENCE", verifiedInput, verified, "GREEN");
  for (const outcome of [
    "COMPILE_FAILURE",
    "COLLECTION_FAILURE",
    "TIMEOUT",
    "PROCESS_CRASH",
    "INFRA_ERROR",
    "NO_TEST_DISCOVERED",
  ] as const) {
    const input = evidenceInput(outcome);
    await add(
      `decide-${outcome.toLowerCase().replaceAll("_", "-")}-non-kill`,
      "DECIDE_EVIDENCE",
      input,
      decideEvidence(input),
      "RED",
    );
  }

  const rawTamper = sealedVerifiedManifest();
  rawTamper.observations[0] = { ...rawTamper.observations[0], outcome: "TIMEOUT" };
  await add(
    "replay-evidence-raw-tamper",
    "REPLAY_EVIDENCE",
    rawTamper,
    replayEvidenceManifest(rawTamper),
    "RED",
  );

  const forgedBase = decideEvidence(evidenceInput("COMPILE_FAILURE"));
  const candidate = forgedBase.candidates[0];
  if (candidate === undefined) throw new Error("CONFORMANCE_CANDIDATE_MISSING");
  forgedBase.candidates[0] = {
    ...candidate,
    status: "ELIGIBLE",
    reasonCodes: ["POLICY_SATISFIED"],
  };
  forgedBase.decision = {
    status: "VERIFIED",
    selectedCandidateIds: ["candidate"],
    reasonCodes: ["POLICY_SATISFIED"],
  };
  forgedBase.decisionDigest = sha256Canonical(decisionDigestProjection(forgedBase));
  const forgedEvidence = sealManifestArtifact(forgedBase);
  await add(
    "replay-evidence-resealed-semantic-forgery",
    "REPLAY_EVIDENCE",
    forgedEvidence,
    replayEvidenceManifest(forgedEvidence),
    "RED",
  );

  const profileInput = profileRequest();
  await add(
    "create-profile-v1-qualified",
    "CREATE_PROFILE_V1",
    profileInput,
    createAgenticProfile(profileInput),
    "GREEN",
  );

  const benchmarkInput = benchmarkRequest();
  const benchmark = createAgenticBenchmark(benchmarkInput);
  await add(
    "create-benchmark-v1-measured",
    "CREATE_BENCHMARK_V1",
    benchmarkInput,
    benchmark,
    "GREEN",
  );
  const forgedBenchmark = structuredClone(benchmark);
  const summary = forgedBenchmark.summaries[0];
  if (summary === undefined) throw new Error("CONFORMANCE_SUMMARY_MISSING");
  forgedBenchmark.summaries[0] = { ...summary, status: "INSUFFICIENT_SAMPLES" };
  const { artifactDigest: _artifactDigest, ...benchmarkProjection } = forgedBenchmark;
  forgedBenchmark.artifactDigest = sha256Canonical(benchmarkProjection);
  await add(
    "replay-benchmark-v1-resealed-summary-forgery",
    "REPLAY_BENCHMARK_V1",
    forgedBenchmark,
    replayAgenticBenchmark(forgedBenchmark),
    "RED",
  );

  await writeJson(outputDirectory, "schemas/expected-digests.json", await schemaExpectedDigests());
  await writeJson(outputDirectory, "bundle.json", {
    schemaVersion: SCHEMA_VERSION,
    bundleId: "testforge-conformance-v1",
    cases,
  });
}

await main(process.argv.slice(2));
