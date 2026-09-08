#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  canonicalize,
  createAgenticBenchmark,
  createAgenticProfile,
  decideEvidence,
  parseAgenticBenchmarkRequest,
  parseAgenticProfileRequest,
  replayAgenticBenchmark,
  replayEvidenceManifest,
  sha256Canonical,
} from "../src/index.js";
import {
  CONFORMANCE_V1_FILE_DIGESTS,
  CONFORMANCE_V1_PUBLIC_DIGESTS,
  CONFORMANCE_V1_ROOT_DIGEST,
} from "./conformance-v1-lock.js";

const ROOT = path.resolve("conformance", "v1");
const SCHEMA_DIRECTORY = path.resolve("schemas");
const OPERATIONS = [
  "CANONICALIZE",
  "DECIDE_EVIDENCE",
  "REPLAY_EVIDENCE",
  "CREATE_PROFILE_V1",
  "CREATE_BENCHMARK_V1",
  "REPLAY_BENCHMARK_V1",
] as const;
type Operation = (typeof OPERATIONS)[number];

interface BundleCase {
  id: string;
  operation: Operation;
  inputPath: string;
  expectedPath: string;
  outcome: "GREEN" | "RED";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}_INVALID`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert.deepStrictEqual(actual, expected, `${label}_FIELDS_INVALID`);
}

function portableIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`${label}_INVALID`);
  }
  return value;
}

function relativeJsonPath(value: unknown, prefix: string, label: string): string {
  if (
    typeof value !== "string" ||
    !value.startsWith(`${prefix}/`) ||
    !value.endsWith(".json") ||
    value.includes("\\") ||
    value.includes("..") ||
    path.posix.normalize(value) !== value
  ) {
    throw new Error(`${label}_INVALID`);
  }
  return value;
}

function parseBundle(value: unknown): BundleCase[] {
  const bundle = record(value, "BUNDLE");
  exactKeys(bundle, ["schemaVersion", "bundleId", "cases"], "BUNDLE");
  assert.equal(bundle.schemaVersion, "1.0.0");
  assert.equal(bundle.bundleId, "testforge-conformance-v1");
  assert.ok(Array.isArray(bundle.cases) && bundle.cases.length > 0);
  const ids = new Set<string>();
  return bundle.cases.map((value, index) => {
    const item = record(value, `CASE_${index}`);
    exactKeys(item, ["id", "operation", "inputPath", "expectedPath", "outcome"], `CASE_${index}`);
    const id = portableIdentifier(item.id, `CASE_${index}_ID`);
    assert.equal(ids.has(id), false, "BUNDLE_CASE_ID_DUPLICATE");
    ids.add(id);
    if (typeof item.operation !== "string" || !OPERATIONS.includes(item.operation as Operation)) {
      throw new Error(`CASE_${index}_OPERATION_INVALID`);
    }
    if (item.outcome !== "GREEN" && item.outcome !== "RED") {
      throw new Error(`CASE_${index}_OUTCOME_INVALID`);
    }
    return {
      id,
      operation: item.operation as Operation,
      inputPath: relativeJsonPath(item.inputPath, "inputs", `CASE_${index}_INPUT`),
      expectedPath: relativeJsonPath(item.expectedPath, "expected", `CASE_${index}_EXPECTED`),
      outcome: item.outcome,
    };
  });
}

async function walk(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(absolute)));
    else if (entry.isFile()) result.push(absolute);
    else throw new Error("CONFORMANCE_SPECIAL_FILE_FORBIDDEN");
  }
  return result;
}

function rawDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function verifyLockedFiles(): Promise<void> {
  const actualPaths = (await walk(ROOT))
    .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
    .sort();
  const expectedPaths = Object.keys(CONFORMANCE_V1_FILE_DIGESTS).sort();
  assert.deepStrictEqual(actualPaths, expectedPaths, "CONFORMANCE_FILE_SET_MISMATCH");
  const rootHash = createHash("sha256");
  for (const relativePath of actualPaths) {
    const bytes = await readFile(path.join(ROOT, relativePath));
    const digest = rawDigest(bytes);
    assert.equal(
      digest,
      CONFORMANCE_V1_FILE_DIGESTS[relativePath as keyof typeof CONFORMANCE_V1_FILE_DIGESTS],
      `CONFORMANCE_RAW_DIGEST_MISMATCH: ${relativePath}`,
    );
    rootHash.update(`${relativePath}\0${digest}\n`);
  }
  assert.equal(
    `sha256:${rootHash.digest("hex")}`,
    CONFORMANCE_V1_ROOT_DIGEST,
    "CONFORMANCE_ROOT_DIGEST_MISMATCH",
  );
}

async function readJson(absolutePath: string): Promise<unknown> {
  return JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
}

async function verifySchemas(): Promise<void> {
  const document = record(
    await readJson(path.join(ROOT, "schemas", "expected-digests.json")),
    "SCHEMA_DIGESTS",
  );
  exactKeys(document, ["schemaVersion", "schemas"], "SCHEMA_DIGESTS");
  assert.equal(document.schemaVersion, "1.0.0");
  assert.ok(Array.isArray(document.schemas));
  assert.equal(document.schemas.length, 34);
  const expectedNames: string[] = [];
  for (const [index, value] of document.schemas.entries()) {
    const item = record(value, `SCHEMA_${index}`);
    exactKeys(item, ["path", "rawSha256", "$id"], `SCHEMA_${index}`);
    assert.equal(typeof item.path, "string");
    assert.equal(typeof item.rawSha256, "string");
    assert.equal(typeof item.$id, "string");
    const prefix = "schemas/";
    assert.ok(item.path.startsWith(prefix) && item.path.endsWith(".json"));
    const name = item.path.slice(prefix.length);
    assert.equal(name.includes("/") || name.includes("\\") || name.includes(".."), false);
    expectedNames.push(name);
    const bytes = await readFile(path.join(SCHEMA_DIRECTORY, name));
    assert.equal(rawDigest(bytes), item.rawSha256, `SCHEMA_RAW_DIGEST_MISMATCH: ${name}`);
    const schema = record(JSON.parse(bytes.toString("utf8")) as unknown, `SCHEMA_${index}`);
    assert.equal(schema.$id, item.$id, `SCHEMA_ID_MISMATCH: ${name}`);
  }
  expectedNames.sort();
  const actualNames = (await readdir(SCHEMA_DIRECTORY))
    .filter((name) => name.endsWith(".json"))
    .sort();
  assert.deepStrictEqual(actualNames, expectedNames, "PUBLISHED_SCHEMA_SET_MISMATCH");
}

function dispatch(operation: Operation, input: unknown): unknown {
  switch (operation) {
    case "CANONICALIZE":
      return { canonical: canonicalize(input), digest: sha256Canonical(input) };
    case "DECIDE_EVIDENCE":
      return decideEvidence(input);
    case "REPLAY_EVIDENCE":
      return replayEvidenceManifest(input);
    case "CREATE_PROFILE_V1":
      return createAgenticProfile(parseAgenticProfileRequest(input));
    case "CREATE_BENCHMARK_V1":
      return createAgenticBenchmark(parseAgenticBenchmarkRequest(input));
    case "REPLAY_BENCHMARK_V1":
      return replayAgenticBenchmark(input);
  }
}

function witnessAssertions(item: BundleCase, input: unknown, actual: unknown): void {
  const output = record(actual, `${item.id}_OUTPUT`);
  if (item.id === "decide-verified") {
    const decision = record(output.decision, "VERIFIED_DECISION");
    assert.equal(decision.status, "VERIFIED");
  }
  if (item.id.startsWith("decide-") && item.id.endsWith("-non-kill")) {
    try {
      const source = record(input, `${item.id}_INPUT`);
      const policy = record(source.policy, `${item.id}_POLICY`);
      assert.deepStrictEqual(policy.acceptedTargetOutcomes, ["ASSERTION_FAILURE"]);
      assert.ok(Array.isArray(output.candidates));
      const candidate = record(output.candidates[0], `${item.id}_CANDIDATE`);
      const decision = record(output.decision, `${item.id}_DECISION`);
      assert.deepStrictEqual(candidate.killedTargetIds, []);
      assert.equal(candidate.targetWeightKilled, 0);
      assert.notEqual(candidate.status, "ELIGIBLE");
      assert.notEqual(decision.status, "VERIFIED");
    } catch (cause) {
      throw new Error(`CONFORMANCE_NON_KILL_ASSERTION_FAILED:${item.id}`, { cause });
    }
  }
  if (item.id === "replay-evidence-raw-tamper") {
    assert.equal(output.valid, false);
    assert.equal(output.artifactDigestValid, false);
  }
  if (item.id === "replay-evidence-resealed-semantic-forgery") {
    assert.equal(output.valid, false);
    assert.equal(output.decisionDigestValid, true);
    assert.equal(output.artifactDigestValid, true);
    assert.equal(output.decisionSemanticsValid, false);
  }
  if (item.id === "replay-benchmark-v1-resealed-summary-forgery") {
    assert.equal(output.valid, false);
    assert.equal(output.artifactDigestValid, true);
    assert.equal(output.summarySemanticsValid, false);
  }
  if (item.id === "create-profile-v1-qualified") {
    assert.equal(output.status, "QUALIFIED");
    assert.deepStrictEqual(output.qualifiedCandidateIds, ["candidate"]);
  }
  if (item.id === "create-benchmark-v1-measured") {
    assert.ok(Array.isArray(output.summaries));
    assert.ok(
      output.summaries.every(
        (summary) => record(summary, "BENCHMARK_SUMMARY").status === "MEASURED",
      ),
    );
  }
}

async function main(): Promise<void> {
  await verifyLockedFiles();
  await verifySchemas();
  const cases = parseBundle(await readJson(path.join(ROOT, "bundle.json")));
  const referencedPaths = new Set(["bundle.json", "schemas/expected-digests.json"]);
  const outputs = new Map<string, unknown>();
  for (const item of cases) {
    referencedPaths.add(item.inputPath);
    referencedPaths.add(item.expectedPath);
    const input = await readJson(path.join(ROOT, item.inputPath));
    const expected = await readJson(path.join(ROOT, item.expectedPath));
    const actual = dispatch(item.operation, input);
    assert.deepStrictEqual(actual, expected, `CONFORMANCE_OUTPUT_MISMATCH: ${item.id}`);
    witnessAssertions(item, input, actual);
    outputs.set(item.id, actual);
  }
  assert.deepStrictEqual(
    [...referencedPaths].sort(),
    Object.keys(CONFORMANCE_V1_FILE_DIGESTS).sort(),
    "CONFORMANCE_UNREFERENCED_FILE",
  );

  const decision = record(outputs.get("decide-verified"), "DECISION_OUTPUT");
  const profile = record(outputs.get("create-profile-v1-qualified"), "PROFILE_OUTPUT");
  const benchmark = record(outputs.get("create-benchmark-v1-measured"), "BENCHMARK_OUTPUT");
  assert.equal(decision.decisionDigest, CONFORMANCE_V1_PUBLIC_DIGESTS.decisionDigest);
  assert.equal(decision.artifactDigest, CONFORMANCE_V1_PUBLIC_DIGESTS.artifactDigest);
  assert.equal(profile.reportDigest, CONFORMANCE_V1_PUBLIC_DIGESTS.profileReportDigest);
  assert.equal(benchmark.artifactDigest, CONFORMANCE_V1_PUBLIC_DIGESTS.benchmarkArtifactDigest);
  process.stdout.write(
    `${JSON.stringify({ status: "CONFORMANCE_VALID", cases: cases.length, rootDigest: CONFORMANCE_V1_ROOT_DIGEST })}\n`,
  );
}

await main();
