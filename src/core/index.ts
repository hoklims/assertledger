export type WorldKind = "REFERENCE" | "TARGET" | "NEUTRAL";

export type CandidateStatus = "ELIGIBLE" | "UNSTABLE" | "INCONCLUSIVE" | "INVALID" | "WEAK_ORACLE";

export type DecisionStatus = "VERIFIED" | "REJECTED" | "INCONCLUSIVE" | "ENGINE_ERROR";

const EVIDENCE_SCHEMA_VERSION = "1.0.0";
const EVIDENCE_POLICY_VERSION = "1.0.0";
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OBSERVATION_OUTCOMES = new Set([
  "PASS",
  "ASSERTION_FAILURE",
  "COLLECTION_FAILURE",
  "COMPILE_FAILURE",
  "PROCESS_CRASH",
  "TIMEOUT",
  "INFRA_ERROR",
  "NO_TEST_DISCOVERED",
]);

export class EvidenceValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvidenceValidationError";
  }
}

interface World {
  id: string;
  kind: WorldKind;
  required: boolean;
  weight: number;
}

interface Candidate {
  id: string;
  digest: string;
  sizeBytes: number;
}

interface Observation {
  runId: string;
  candidateId: string | null;
  worldId: string;
  attempt: number;
  outcome: string;
  testsDiscovered: number;
  candidateTestsDiscovered: number;
  attributed: boolean;
  durationMs?: number;
  exitCode?: number | null;
  stdoutDigest?: string;
  stderrDigest?: string;
}

export interface EvidenceContext {
  engine: {
    name: string;
    version: string;
  };
  adapter: {
    name: string;
    version: string;
    configuration: JsonValue;
  };
  execution: {
    isolation: string;
    environmentAllowlist: string[];
    budgets: JsonValue;
    candidateRoots: string[];
  };
  worlds: Array<{
    id: string;
    provenance: string;
    digest: string;
  }>;
}

interface Policy {
  policyVersion: string;
  requiredAttempts: number;
  minimumTargetWeightPermille: number;
  maximumSelectedCandidates: number;
  acceptedTargetOutcomes: string[];
}

interface EvidenceInput {
  schemaVersion: string;
  repositoryDigest: string;
  evidenceContext: EvidenceContext;
  policy: Policy;
  worlds: World[];
  candidates: Candidate[];
  observations: Observation[];
}

export interface CandidateAssessment extends Candidate {
  status: CandidateStatus;
  killedTargetIds: string[];
  targetWeightKilled: number;
  gates: GateResult[];
  reasonCodes: string[];
}

export type GateName =
  | "COMPLETENESS"
  | "STABILITY"
  | "DISCOVERY"
  | "REFERENCE"
  | "NEUTRAL"
  | "TARGET_STRENGTH";

export interface GateResult {
  name: GateName;
  status: "PASSED" | "FAILED" | "NOT_RUN";
  evidenceRunIds: string[];
  reasonCodes: string[];
}

export interface EvidenceManifest {
  schemaVersion: string;
  repositoryDigest: string;
  evidenceContext: EvidenceContext;
  policy: Policy;
  worlds: World[];
  candidates: CandidateAssessment[];
  observations: Observation[];
  decision: {
    status: DecisionStatus;
    selectedCandidateIds: string[];
    reasonCodes: string[];
  };
  decisionDigest: string;
  artifactDigest: string;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") {
    throw new TypeError("undefined is not a canonical JSON value");
  }
  if (typeof value !== "object") {
    throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("Canonical JSON cannot contain cycles");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError("Canonical JSON arrays cannot contain holes");
        items.push(canonicalJson(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON requires plain objects");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareOrdinal);
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`,
    );
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalize(value: unknown): string {
  return canonicalJson(value, new Set());
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function sha256(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15] ?? 0;
      const previous2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h + sum1 + choice + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1) {
      state[index] = ((state[index] ?? 0) + (next[index] ?? 0)) >>> 0;
    }
  }

  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

export function sha256Canonical(value: unknown): string {
  return `sha256:${sha256(canonicalize(value))}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${key} must be a non-empty string`);
  return value;
}

function boundedStringField(record: Record<string, unknown>, key: string, maximum: number): string {
  const value = stringField(record, key);
  if (value.length > maximum) throw new TypeError(`${key} must not exceed ${maximum} characters`);
  return value;
}

function digestField(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key);
  if (!SHA256_DIGEST_PATTERN.test(value)) throw new TypeError(`${key} must be a SHA-256 digest`);
  return value;
}

function identifierField(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key);
  if (value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new TypeError(`${key} must be a portable ASCII identifier`);
  }
  return value;
}

function integerField(record: Record<string, unknown>, key: string, minimum = 0): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new TypeError(`${key} must be an integer >= ${minimum}`);
  return value as number;
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function jsonField(record: Record<string, unknown>, key: string): JsonValue {
  const value = record[key];
  canonicalize(value);
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function sortedUniqueStrings(
  record: Record<string, unknown>,
  key: string,
  maximumItems: number,
  maximumLength: number,
): string[] {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.length > maximumItems ||
    value.some(
      (item) => typeof item !== "string" || item.length === 0 || item.length > maximumLength,
    )
  ) {
    throw new TypeError(`${key} exceeds its string-array bounds`);
  }
  return [...new Set(value)].sort(compareOrdinal);
}

function parseEvidenceContext(value: unknown): EvidenceContext {
  if (!isRecord(value)) throw new TypeError("evidenceContext must be an object");
  if (!isRecord(value.engine)) throw new TypeError("evidenceContext.engine must be an object");
  if (!isRecord(value.adapter)) throw new TypeError("evidenceContext.adapter must be an object");
  if (!isRecord(value.execution)) {
    throw new TypeError("evidenceContext.execution must be an object");
  }
  if (!Array.isArray(value.worlds) || value.worlds.length === 0) {
    throw new TypeError("evidenceContext.worlds must be non-empty");
  }

  const worlds = value.worlds
    .map((raw) => {
      if (!isRecord(raw)) throw new TypeError("evidenceContext world must be an object");
      return {
        id: identifierField(raw, "id"),
        provenance: boundedStringField(raw, "provenance", 1_024),
        digest: digestField(raw, "digest"),
      };
    })
    .sort((left, right) => compareOrdinal(left.id, right.id));
  if (new Set(worlds.map((world) => world.id)).size !== worlds.length) {
    throw new TypeError("Duplicate evidenceContext world id");
  }

  return {
    engine: {
      name: boundedStringField(value.engine, "name", 128),
      version: boundedStringField(value.engine, "version", 128),
    },
    adapter: {
      name: boundedStringField(value.adapter, "name", 128),
      version: boundedStringField(value.adapter, "version", 128),
      configuration: jsonField(value.adapter, "configuration"),
    },
    execution: {
      isolation: boundedStringField(value.execution, "isolation", 128),
      environmentAllowlist: sortedUniqueStrings(value.execution, "environmentAllowlist", 100, 128),
      budgets: jsonField(value.execution, "budgets"),
      candidateRoots: sortedUniqueStrings(value.execution, "candidateRoots", 100, 512),
    },
    worlds,
  };
}

function parseInputUnchecked(input: unknown): EvidenceInput {
  if (!isRecord(input)) throw new TypeError("Evidence must be an object");
  const schemaVersion = stringField(input, "schemaVersion");
  if (schemaVersion !== EVIDENCE_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported schemaVersion: ${schemaVersion}`);
  }
  const policyValue = input.policy;
  if (!isRecord(policyValue)) throw new TypeError("policy must be an object");
  const policyVersion = stringField(policyValue, "policyVersion");
  if (policyVersion !== EVIDENCE_POLICY_VERSION) {
    throw new TypeError(`Unsupported policyVersion: ${policyVersion}`);
  }
  const attempts = integerField(policyValue, "requiredAttempts", 1);
  if (attempts > 1_000) throw new TypeError("requiredAttempts must not exceed 1000");
  const minimum = integerField(policyValue, "minimumTargetWeightPermille", 1);
  if (minimum > 1_000) throw new TypeError("minimumTargetWeightPermille must not exceed 1000");
  const acceptedValue = policyValue.acceptedTargetOutcomes;
  if (
    !Array.isArray(acceptedValue) ||
    acceptedValue.length !== 1 ||
    acceptedValue[0] !== "ASSERTION_FAILURE"
  ) {
    throw new TypeError("acceptedTargetOutcomes must be exactly [ASSERTION_FAILURE]");
  }
  const policy: Policy = {
    policyVersion,
    requiredAttempts: attempts,
    minimumTargetWeightPermille: minimum,
    maximumSelectedCandidates: integerField(policyValue, "maximumSelectedCandidates", 1),
    acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
  };
  if (policy.maximumSelectedCandidates > 1_000) {
    throw new TypeError("maximumSelectedCandidates must not exceed 1000");
  }

  if (!Array.isArray(input.worlds) || input.worlds.length === 0)
    throw new TypeError("worlds must be non-empty");
  const worlds: World[] = input.worlds
    .map((raw) => {
      if (!isRecord(raw)) throw new TypeError("world must be an object");
      const kind: unknown = raw.kind;
      if (kind !== "REFERENCE" && kind !== "TARGET" && kind !== "NEUTRAL")
        throw new TypeError("Invalid world kind");
      if (typeof raw.required !== "boolean") throw new TypeError("world.required must be boolean");
      const world: World = {
        id: identifierField(raw, "id"),
        kind,
        required: raw.required,
        weight: integerField(raw, "weight"),
      };
      if (kind === "TARGET" && world.weight < 1) {
        throw new TypeError("TARGET world weight must be at least 1");
      }
      if (kind !== "TARGET" && world.weight !== 0) {
        throw new TypeError("Non-target world weight must be 0");
      }
      if (world.weight > 1_000_000) throw new TypeError("world weight must not exceed 1000000");
      return world;
    })
    .sort((left, right) => compareOrdinal(left.id, right.id));
  if (new Set(worlds.map((world) => world.id)).size !== worlds.length)
    throw new TypeError("Duplicate world id");
  for (const kind of ["REFERENCE", "TARGET", "NEUTRAL"] as const) {
    if (!worlds.some((world) => world.kind === kind && world.required)) {
      throw new TypeError(`At least one required ${kind} world is required`);
    }
  }
  const worldIds = new Set(worlds.map((world) => world.id));
  const evidenceContext = parseEvidenceContext(input.evidenceContext);
  if (
    evidenceContext.worlds.length !== worlds.length ||
    evidenceContext.worlds.some((world) => !worldIds.has(world.id))
  ) {
    throw new TypeError("evidenceContext worlds must exactly match decision worlds");
  }

  if (!Array.isArray(input.candidates) || input.candidates.length === 0) {
    throw new TypeError("candidates must be non-empty");
  }
  const candidates: Candidate[] = input.candidates
    .map((raw) => {
      if (!isRecord(raw)) throw new TypeError("candidate must be an object");
      return {
        id: identifierField(raw, "id"),
        digest: digestField(raw, "digest"),
        sizeBytes: integerField(raw, "sizeBytes"),
      };
    })
    .sort((left, right) => compareOrdinal(left.id, right.id));
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length)
    throw new TypeError("Duplicate candidate id");
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));

  if (!Array.isArray(input.observations)) throw new TypeError("observations must be an array");
  const observations: Observation[] = input.observations
    .map((raw) => {
      if (!isRecord(raw)) throw new TypeError("observation must be an object");
      const candidateId = raw.candidateId;
      if (
        candidateId !== null &&
        (typeof candidateId !== "string" || !candidateIds.has(candidateId))
      )
        throw new TypeError("Unknown candidateId");
      const worldId = stringField(raw, "worldId");
      if (!worldIds.has(worldId)) throw new TypeError("Unknown worldId");
      if (typeof raw.attributed !== "boolean") throw new TypeError("attributed must be boolean");
      const duration = raw.durationMs;
      if (
        duration !== undefined &&
        (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)
      )
        throw new TypeError("durationMs must be finite and non-negative");
      const exitCode = raw.exitCode;
      if (
        exitCode !== undefined &&
        exitCode !== null &&
        (!Number.isSafeInteger(exitCode) || (exitCode as number) < 0)
      ) {
        throw new TypeError("exitCode must be null or a non-negative integer");
      }
      const stdoutDigest =
        raw.stdoutDigest === undefined ? undefined : digestField(raw, "stdoutDigest");
      const stderrDigest =
        raw.stderrDigest === undefined ? undefined : digestField(raw, "stderrDigest");
      const testsDiscovered = integerField(raw, "testsDiscovered");
      const candidateTestsDiscovered = integerField(raw, "candidateTestsDiscovered");
      if (candidateTestsDiscovered > testsDiscovered) {
        throw new TypeError("candidateTestsDiscovered must not exceed testsDiscovered");
      }
      const outcome = boundedStringField(raw, "outcome", 64);
      if (!OBSERVATION_OUTCOMES.has(outcome)) throw new TypeError("Invalid observation outcome");
      return {
        runId: boundedStringField(raw, "runId", 512),
        candidateId,
        worldId,
        attempt: integerField(raw, "attempt", 1),
        outcome,
        testsDiscovered,
        candidateTestsDiscovered,
        attributed: raw.attributed,
        ...(duration === undefined ? {} : { durationMs: duration }),
        ...(exitCode === undefined ? {} : { exitCode: exitCode as number | null }),
        ...(stdoutDigest === undefined ? {} : { stdoutDigest }),
        ...(stderrDigest === undefined ? {} : { stderrDigest }),
      };
    })
    .sort(compareObservations);
  if (new Set(observations.map((item) => item.runId)).size !== observations.length)
    throw new TypeError("Duplicate runId");

  return {
    schemaVersion,
    repositoryDigest: digestField(input, "repositoryDigest"),
    evidenceContext,
    policy,
    worlds,
    candidates,
    observations,
  };
}

function parseInput(input: unknown): EvidenceInput {
  try {
    return parseInputUnchecked(input);
  } catch (error) {
    if (error instanceof EvidenceValidationError) throw error;
    if (error instanceof TypeError) {
      throw new EvidenceValidationError(error.message, { cause: error });
    }
    throw error;
  }
}

function compareObservations(left: Observation, right: Observation): number {
  return (
    compareOrdinal(left.candidateId ?? "", right.candidateId ?? "") ||
    compareOrdinal(left.worldId, right.worldId) ||
    left.attempt - right.attempt ||
    compareOrdinal(left.runId, right.runId)
  );
}

const INCONCLUSIVE_OUTCOMES = new Set(["TIMEOUT", "INFRA_ERROR"]);

function runsFor(input: EvidenceInput, candidateId: string | null, worldId: string): Observation[] {
  return input.observations.filter(
    (run) => run.candidateId === candidateId && run.worldId === worldId,
  );
}

function isComplete(runs: Observation[], requiredAttempts: number): boolean {
  if (runs.length !== requiredAttempts) return false;
  const attempts = new Set(runs.map((run) => run.attempt));
  if (attempts.size !== requiredAttempts) return false;
  for (let attempt = 1; attempt <= requiredAttempts; attempt += 1)
    if (!attempts.has(attempt)) return false;
  return true;
}

function isCompleteStable(runs: Observation[], requiredAttempts: number): boolean {
  if (!isComplete(runs, requiredAttempts)) return false;
  return runs.every((run) => run.outcome === runs[0]?.outcome);
}

function controlsAreValid(input: EvidenceInput): boolean {
  return input.worlds.every((world) => {
    const runs = runsFor(input, null, world.id);
    return (
      isCompleteStable(runs, input.policy.requiredAttempts) &&
      runs.every(
        (run) => run.outcome === "PASS" && run.candidateTestsDiscovered === 0 && !run.attributed,
      )
    );
  });
}

function assessCandidate(input: EvidenceInput, candidate: Candidate): CandidateAssessment {
  const worldRuns = input.worlds.map((world) => ({
    world,
    runs: runsFor(input, candidate.id, world.id),
  }));
  const allRuns = worldRuns.flatMap(({ runs }) => runs).sort(compareObservations);
  const ids = (runs: Observation[]) => runs.map((run) => run.runId).sort(compareOrdinal);
  const notRun = (name: GateName): GateResult => ({
    name,
    status: "NOT_RUN",
    evidenceRunIds: [],
    reasonCodes: ["PREREQUISITE_GATE_FAILED"],
  });
  const gates: GateResult[] = [];
  const complete = worldRuns.every(({ runs }) => isComplete(runs, input.policy.requiredAttempts));
  gates.push({
    name: "COMPLETENESS",
    status: complete ? "PASSED" : "FAILED",
    evidenceRunIds: ids(allRuns),
    reasonCodes: complete ? [] : ["CANDIDATE_EVIDENCE_INCOMPLETE"],
  });
  if (!complete) {
    gates.push(
      notRun("STABILITY"),
      notRun("DISCOVERY"),
      notRun("REFERENCE"),
      notRun("NEUTRAL"),
      notRun("TARGET_STRENGTH"),
    );
    return {
      ...candidate,
      status: "INCONCLUSIVE",
      killedTargetIds: [],
      targetWeightKilled: 0,
      gates,
      reasonCodes: ["CANDIDATE_EVIDENCE_INCOMPLETE"],
    };
  }

  const stable = worldRuns.every(({ runs }) =>
    isCompleteStable(runs, input.policy.requiredAttempts),
  );
  gates.push({
    name: "STABILITY",
    status: stable ? "PASSED" : "FAILED",
    evidenceRunIds: ids(allRuns),
    reasonCodes: stable ? [] : ["OBSERVATIONS_DIVERGE"],
  });
  if (!stable) {
    gates.push(
      notRun("DISCOVERY"),
      notRun("REFERENCE"),
      notRun("NEUTRAL"),
      notRun("TARGET_STRENGTH"),
    );
    return {
      ...candidate,
      status: "UNSTABLE",
      killedTargetIds: [],
      targetWeightKilled: 0,
      gates,
      reasonCodes: ["OBSERVATIONS_DIVERGE"],
    };
  }

  const discoveryValid = allRuns.every(
    (run) => run.candidateTestsDiscovered >= 1 && run.attributed,
  );
  gates.push({
    name: "DISCOVERY",
    status: discoveryValid ? "PASSED" : "FAILED",
    evidenceRunIds: ids(allRuns),
    reasonCodes: discoveryValid ? [] : ["CANDIDATE_DISCOVERY_INVALID"],
  });
  if (!discoveryValid) {
    gates.push(notRun("REFERENCE"), notRun("NEUTRAL"), notRun("TARGET_STRENGTH"));
    return {
      ...candidate,
      status: "INVALID",
      killedTargetIds: [],
      targetWeightKilled: 0,
      gates,
      reasonCodes: ["CANDIDATE_DISCOVERY_INVALID"],
    };
  }

  const referenceRuns = worldRuns
    .filter(({ world }) => world.kind === "REFERENCE")
    .flatMap(({ runs }) => runs);
  const referencePassed = referenceRuns.every((run) => run.outcome === "PASS");
  gates.push({
    name: "REFERENCE",
    status: referencePassed ? "PASSED" : "FAILED",
    evidenceRunIds: ids(referenceRuns),
    reasonCodes: referencePassed ? [] : ["REFERENCE_NOT_GREEN"],
  });
  const neutralRuns = worldRuns
    .filter(({ world }) => world.kind === "NEUTRAL")
    .flatMap(({ runs }) => runs);
  const neutralPassed = neutralRuns.every((run) => run.outcome === "PASS");
  gates.push({
    name: "NEUTRAL",
    status: neutralPassed ? "PASSED" : "FAILED",
    evidenceRunIds: ids(neutralRuns),
    reasonCodes: neutralPassed ? [] : ["NEUTRAL_NOT_GREEN"],
  });

  const killedWorlds = worldRuns
    .filter(
      ({ world, runs }) =>
        world.kind === "TARGET" &&
        runs.every((run) => run.attributed && run.outcome === "ASSERTION_FAILURE"),
    )
    .map(({ world }) => world);
  const killedTargetIds = killedWorlds.map((world) => world.id).sort(compareOrdinal);
  const targetWeightKilled = killedWorlds.reduce((sum, world) => sum + world.weight, 0);
  const allTargets = input.worlds.filter((world) => world.kind === "TARGET");
  const totalWeight = allTargets.reduce((sum, world) => sum + world.weight, 0);
  const requiredKilled = allTargets
    .filter((world) => world.required)
    .every((world) => killedTargetIds.includes(world.id));
  const thresholdMet =
    totalWeight > 0 &&
    targetWeightKilled * 1_000 >= totalWeight * input.policy.minimumTargetWeightPermille;
  const targetPassed = requiredKilled && thresholdMet;
  const targetRuns = worldRuns
    .filter(({ world }) => world.kind === "TARGET")
    .flatMap(({ runs }) => runs);
  const targetExecutionInconclusive = targetRuns.some((run) =>
    INCONCLUSIVE_OUTCOMES.has(run.outcome),
  );
  gates.push({
    name: "TARGET_STRENGTH",
    status: targetPassed ? "PASSED" : "FAILED",
    evidenceRunIds: ids(targetRuns),
    reasonCodes: targetPassed
      ? []
      : [
          targetExecutionInconclusive
            ? "CANDIDATE_EXECUTION_INCONCLUSIVE"
            : "TARGET_STRENGTH_INSUFFICIENT",
        ],
  });

  const executionInconclusive = allRuns.some((run) => INCONCLUSIVE_OUTCOMES.has(run.outcome));
  const status: CandidateStatus = executionInconclusive
    ? "INCONCLUSIVE"
    : !referencePassed || !neutralPassed
      ? "INVALID"
      : targetPassed
        ? "ELIGIBLE"
        : "WEAK_ORACLE";
  const reasonCodes = executionInconclusive
    ? ["CANDIDATE_EXECUTION_INCONCLUSIVE"]
    : !referencePassed
      ? ["REFERENCE_NOT_GREEN"]
      : !neutralPassed
        ? ["NEUTRAL_NOT_GREEN"]
        : targetPassed
          ? ["POLICY_SATISFIED"]
          : ["TARGET_STRENGTH_INSUFFICIENT"];
  return {
    ...candidate,
    status,
    killedTargetIds,
    targetWeightKilled,
    gates,
    reasonCodes,
  };
}

export function selectCandidates(assessments: unknown[], maximum: number): string[] {
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || !Array.isArray(assessments)) return [];
  const eligible = assessments.flatMap((raw) => {
    if (
      !isRecord(raw) ||
      raw.status !== "ELIGIBLE" ||
      typeof raw.id !== "string" ||
      typeof raw.digest !== "string" ||
      !Number.isSafeInteger(raw.sizeBytes) ||
      !Array.isArray(raw.killedTargetIds) ||
      raw.killedTargetIds.some((id) => typeof id !== "string")
    )
      return [];
    return [
      {
        id: raw.id,
        digest: raw.digest,
        sizeBytes: raw.sizeBytes as number,
        killedTargetIds: [...new Set(raw.killedTargetIds as string[])].sort(compareOrdinal),
      },
    ];
  });
  const selected: string[] = [];
  const covered = new Set<string>();
  const remaining = [...eligible];
  while (selected.length < maximum && remaining.length > 0) {
    remaining.sort((left, right) => {
      const leftMarginal = left.killedTargetIds.filter((id) => !covered.has(id)).length;
      const rightMarginal = right.killedTargetIds.filter((id) => !covered.has(id)).length;
      return (
        rightMarginal - leftMarginal ||
        left.sizeBytes - right.sizeBytes ||
        compareOrdinal(left.digest, right.digest) ||
        compareOrdinal(left.id, right.id)
      );
    });
    const best = remaining.shift();
    if (!best || best.killedTargetIds.every((id) => covered.has(id))) break;
    selected.push(best.id);
    for (const id of best.killedTargetIds) covered.add(id);
  }
  return selected;
}

function digestProjection(
  manifest: Omit<EvidenceManifest, "decisionDigest" | "artifactDigest"> | EvidenceManifest,
): JsonValue {
  return {
    schemaVersion: manifest.schemaVersion,
    repositoryDigest: manifest.repositoryDigest,
    evidenceContext: manifest.evidenceContext as unknown as JsonValue,
    policy: manifest.policy as unknown as JsonValue,
    worlds: [...manifest.worlds].sort((a, b) => compareOrdinal(a.id, b.id)) as unknown as JsonValue,
    candidates: [...manifest.candidates].sort((a, b) =>
      compareOrdinal(a.id, b.id),
    ) as unknown as JsonValue,
    observations: [...manifest.observations]
      .sort(compareObservations)
      .map(
        ({
          durationMs: _durationMs,
          exitCode: _exitCode,
          stdoutDigest: _stdoutDigest,
          stderrDigest: _stderrDigest,
          ...run
        }) => run,
      ) as unknown as JsonValue,
    decision: manifest.decision as unknown as JsonValue,
  };
}

function artifactProjection(manifest: Record<string, unknown>): JsonValue {
  const { artifactDigest: _artifactDigest, ...artifact } = manifest;
  return artifact as JsonValue;
}

export function sealManifestArtifact<T extends Record<string, unknown>>(
  manifest: T,
): T & { artifactDigest: string } {
  return {
    ...manifest,
    artifactDigest: sha256Canonical(artifactProjection(manifest)),
  };
}

function finishManifest(
  base: Omit<EvidenceManifest, "decisionDigest" | "artifactDigest">,
): EvidenceManifest {
  const decisionSealed = {
    ...base,
    decisionDigest: sha256Canonical(digestProjection(base)),
  };
  return sealManifestArtifact(decisionSealed);
}

export function decideEvidence(input: unknown): EvidenceManifest {
  let evidence: EvidenceInput;
  try {
    evidence = parseInput(input);
  } catch (error) {
    if (!(error instanceof EvidenceValidationError)) throw error;
    return finishManifest({
      schemaVersion: "1.0.0",
      repositoryDigest: "invalid",
      evidenceContext: {
        engine: { name: "invalid", version: "invalid" },
        adapter: { name: "invalid", version: "invalid", configuration: {} },
        execution: {
          isolation: "invalid",
          environmentAllowlist: [],
          budgets: {},
          candidateRoots: [],
        },
        worlds: [],
      },
      policy: {
        policyVersion: "invalid",
        requiredAttempts: 1,
        minimumTargetWeightPermille: 1_000,
        maximumSelectedCandidates: 0,
        acceptedTargetOutcomes: [],
      },
      worlds: [],
      candidates: [],
      observations: [],
      decision: {
        status: "ENGINE_ERROR",
        selectedCandidateIds: [],
        reasonCodes: ["EVIDENCE_INPUT_INVALID"],
      },
    });
  }

  const candidates = evidence.candidates.map((candidate) => assessCandidate(evidence, candidate));
  const invalidControls = !controlsAreValid(evidence);
  const hasInconclusiveCandidate = candidates.some(
    (candidate) => candidate.status === "UNSTABLE" || candidate.status === "INCONCLUSIVE",
  );
  const selectedCandidateIds = invalidControls
    ? []
    : selectCandidates(candidates, evidence.policy.maximumSelectedCandidates);
  const status: DecisionStatus = invalidControls
    ? "INCONCLUSIVE"
    : selectedCandidateIds.length > 0
      ? "VERIFIED"
      : hasInconclusiveCandidate
        ? "INCONCLUSIVE"
        : "REJECTED";
  const reasonCodes = [
    ...(invalidControls ? ["CONTROL_EVIDENCE_INVALID"] : []),
    ...(!invalidControls && selectedCandidateIds.length > 0 ? ["POLICY_SATISFIED"] : []),
    ...(!invalidControls && selectedCandidateIds.length === 0 && hasInconclusiveCandidate
      ? ["CANDIDATE_EVIDENCE_INCONCLUSIVE"]
      : []),
    ...(!invalidControls && selectedCandidateIds.length === 0 && !hasInconclusiveCandidate
      ? ["NO_ELIGIBLE_CANDIDATE"]
      : []),
  ];
  return finishManifest({
    ...evidence,
    candidates,
    decision: { status, selectedCandidateIds, reasonCodes },
  });
}

export function verifyDecisionDigest(manifest: unknown): { valid: boolean } {
  if (!isRecord(manifest) || typeof manifest.decisionDigest !== "string") return { valid: false };
  try {
    const candidate = manifest as unknown as EvidenceManifest;
    return { valid: candidate.decisionDigest === sha256Canonical(digestProjection(candidate)) };
  } catch {
    return { valid: false };
  }
}

export function verifyManifestIntegrity(manifest: unknown): {
  valid: boolean;
  decisionDigestValid: boolean;
  artifactDigestValid: boolean;
} {
  if (!isRecord(manifest)) {
    return { valid: false, decisionDigestValid: false, artifactDigestValid: false };
  }
  const decisionDigestValid = verifyDecisionDigest(manifest).valid;
  let artifactDigestValid = false;
  try {
    artifactDigestValid =
      typeof manifest.artifactDigest === "string" &&
      manifest.artifactDigest === sha256Canonical(artifactProjection(manifest));
  } catch {
    artifactDigestValid = false;
  }
  return {
    valid: decisionDigestValid && artifactDigestValid,
    decisionDigestValid,
    artifactDigestValid,
  };
}

export interface EvidenceReplayResult {
  valid: boolean;
  decisionDigestValid: boolean;
  artifactDigestValid: boolean;
  decisionSemanticsValid: boolean;
}

function replayCandidateSemantics(candidates: unknown): JsonValue {
  if (!Array.isArray(candidates)) throw new TypeError("manifest.candidates must be an array");
  return candidates
    .map((raw) => {
      if (!isRecord(raw)) throw new TypeError("manifest candidate must be an object");
      return {
        id: stringField(raw, "id"),
        digest: stringField(raw, "digest"),
        sizeBytes: integerField(raw, "sizeBytes"),
        status: stringField(raw, "status"),
        killedTargetIds: jsonField(raw, "killedTargetIds"),
        targetWeightKilled: integerField(raw, "targetWeightKilled"),
        gates: jsonField(raw, "gates"),
        reasonCodes: jsonField(raw, "reasonCodes"),
      };
    })
    .sort((left, right) => compareOrdinal(left.id, right.id)) as JsonValue;
}

export function replayEvidenceManifest(manifest: unknown): EvidenceReplayResult {
  const invalid = {
    valid: false,
    decisionDigestValid: false,
    artifactDigestValid: false,
    decisionSemanticsValid: false,
  };
  if (!isRecord(manifest)) return invalid;

  const integrity = verifyManifestIntegrity(manifest);
  try {
    if (
      !isRecord(manifest.evidenceContext) ||
      !isRecord(manifest.policy) ||
      !Array.isArray(manifest.worlds) ||
      !Array.isArray(manifest.candidates) ||
      !Array.isArray(manifest.observations) ||
      !isRecord(manifest.decision)
    ) {
      throw new TypeError("Manifest does not contain replayable evidence");
    }
    const candidates = manifest.candidates.map((raw) => {
      if (!isRecord(raw)) throw new TypeError("manifest candidate must be an object");
      return {
        id: stringField(raw, "id"),
        digest: stringField(raw, "digest"),
        sizeBytes: integerField(raw, "sizeBytes"),
      };
    });
    const replayed = decideEvidence({
      schemaVersion: manifest.schemaVersion,
      repositoryDigest: manifest.repositoryDigest,
      evidenceContext: manifest.evidenceContext,
      policy: manifest.policy,
      worlds: manifest.worlds,
      candidates,
      observations: manifest.observations,
    });
    const decisionSemanticsValid =
      replayed.decision.status !== "ENGINE_ERROR" &&
      replayed.decisionDigest === manifest.decisionDigest &&
      canonicalize({
        candidates: replayCandidateSemantics(replayed.candidates),
        decision: replayed.decision,
      }) ===
        canonicalize({
          candidates: replayCandidateSemantics(manifest.candidates),
          decision: manifest.decision,
        });
    return {
      valid:
        integrity.decisionDigestValid && integrity.artifactDigestValid && decisionSemanticsValid,
      decisionDigestValid: integrity.decisionDigestValid,
      artifactDigestValid: integrity.artifactDigestValid,
      decisionSemanticsValid,
    };
  } catch {
    return {
      ...invalid,
      decisionDigestValid: integrity.decisionDigestValid,
      artifactDigestValid: integrity.artifactDigestValid,
    };
  }
}

function normalizeRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
    throw new TypeError("Path must be a non-empty relative path");
  if (/^(?:[a-zA-Z]:|[\\/]{1,2})/.test(value) || value.includes(":"))
    throw new TypeError("Absolute paths and Windows ADS are forbidden");
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    throw new TypeError("Path traversal or ambiguous segments are forbidden");
  for (const segment of segments) {
    if (segment.normalize("NFC") !== segment) {
      throw new TypeError("Ambiguous Unicode path segment must use NFC");
    }
    const hasControlCharacter = [...segment].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    });
    if (hasControlCharacter || /[<>"|?*]/u.test(segment)) {
      throw new TypeError("Control or Windows-forbidden filename character");
    }
    if (/[. ]$/u.test(segment)) throw new TypeError("Ambiguous Windows path segment");
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)) {
      throw new TypeError("Reserved Windows device name");
    }
  }
  return segments.join("/");
}

export function portablePathKey(path: string): string {
  return normalizeRelativePath(path).toLowerCase().normalize("NFC");
}

export function assertSafeRelativePath(path: string, roots: string[]): string {
  const normalized = normalizeRelativePath(path);
  if (!Array.isArray(roots) || roots.length === 0)
    throw new TypeError("At least one safe root is required");
  const normalizedRoots = roots.map((root) => {
    if (root === ".") return ".";
    if (typeof root !== "string") throw new TypeError("Safe roots must be strings");
    return normalizeRelativePath(root.replace(/[\\/]+$/, ""));
  });
  const pathKey = portablePathKey(normalized);
  if (
    !normalizedRoots.some((root) => {
      if (root === ".") return true;
      const rootKey = portablePathKey(root);
      return pathKey === rootKey || pathKey.startsWith(`${rootKey}/`);
    })
  ) {
    throw new TypeError("Path is outside the allowed roots");
  }
  return normalized;
}
