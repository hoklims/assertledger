import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  type AgenticCorpusAllocationCommitment,
  type AgenticCorpusProvenance,
  type AgenticCorpusTrustPolicy,
  parseAgenticCorpusProvenance,
  parseAgenticCorpusTrustPolicy,
} from "../contracts/index.js";
import {
  agenticCorpusAllocationCommitmentSigningBytes,
  canonicalize,
  portablePathKey,
  sha256Canonical,
} from "../core/index.js";

const SCHEMA_VERSION = "1.0.0" as const;
const CASE_SUFFIX = ".case.json";
const PORTABLE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const HYPOTHESES = ["H1", "H2", "H3", "H4"] as const;

type Hypothesis = (typeof HYPOTHESES)[number];
type Outcome = "SUPPORT" | "OPPOSITION" | "INSUFFICIENT";

export class AgenticCorpusError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "AgenticCorpusError";
  }
}

export interface AgenticCorpusCase {
  schemaVersion: typeof SCHEMA_VERSION;
  caseId: string;
  sourceId: string;
  sourceRevision: string;
  h1?: {
    equalTargetStrength: boolean;
    baselineWarmP95Us: number;
    profileWarmP95Us: number;
  };
  h2?: {
    baselineNeutralSurvived: number;
    baselineNeutralTotal: number;
    profileNeutralSurvived: number;
    profileNeutralTotal: number;
  };
  h3?: {
    equalBudget: boolean;
    baselineHeldOutFaultsDetected: number;
    baselineHeldOutFaultsTotal: number;
    profileHeldOutFaultsDetected: number;
    profileHeldOutFaultsTotal: number;
  };
  h4?: {
    reviewedReduction: boolean;
    baselineHistoricalFaultsDetected: number;
    baselineHistoricalFaultsTotal: number;
    profileHistoricalFaultsDetected: number;
    profileHistoricalFaultsTotal: number;
    baselineCostUs: number;
    profileCostUs: number;
    baselineMutantCount: number;
    profileMutantCount: number;
  };
}

interface LoadedCorpus {
  publicCases: LoadedCase[];
  holdoutCases: LoadedCase[];
}

interface LoadedCase extends AgenticCorpusCase {
  provenanceDigest: string;
  sourceIdentityDigest: string;
  fileBasenameKey: string;
}

export interface AgenticCorpusTrustOptions {
  policy: unknown;
  expectedPolicyDigest: string;
}

export interface AgenticCorpusProvenanceReplayResult {
  valid: boolean;
  schemaValid: boolean;
  canonicalCaseDigestValid: boolean;
  policyDigestValid: boolean;
  sourceRegistered: boolean;
  sourceBindingValid: boolean;
  executionReceiptDigestValid: boolean;
  authorTrusted: boolean;
  reviewerTrusted: boolean;
  principalsDistinct: boolean;
  authorSignatureValid: boolean;
  reviewerSignatureValid: boolean;
  provenanceDigestValid: boolean;
}

interface HypothesisOutcome {
  outcome: Outcome;
  reasonCodes: string[];
}

interface Aggregate {
  support: number;
  opposition: number;
  insufficient: number;
}

export type ReadinessGate =
  | "PROVENANCE_POLICY_REQUIRED"
  | "MINIMUM_CASES_NOT_MET"
  | "MINIMUM_SOURCES_NOT_MET"
  | "PUBLIC_SPLIT_EMPTY"
  | "HOLDOUT_SPLIT_EMPTY"
  | "H1_EVIDENCE_MISSING"
  | "H2_EVIDENCE_MISSING"
  | "H3_EVIDENCE_MISSING"
  | "H4_EVIDENCE_MISSING";

export interface AgenticCorpusStatus {
  schemaVersion: typeof SCHEMA_VERSION;
  status: "READY" | "NOT_READY";
  failedGates: ReadinessGate[];
  counts: {
    totalCases: number;
    publicCases: number;
    holdoutCases: number;
    distinctSources: number;
    evaluable: Record<Hypothesis, number>;
  };
}

function invalid(code = "AGENTIC_CORPUS_CASE_INVALID"): never {
  throw new AgenticCorpusError(code);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))) invalid();
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid();
}

function portableIdentifier(value: unknown): string {
  if (typeof value !== "string" || !PORTABLE_IDENTIFIER.test(value)) return invalid();
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) return invalid();
  return value;
}

export function agenticCorpusTrustPolicyDigest(
  policy: Omit<AgenticCorpusTrustPolicy, "policyDigest">,
): string {
  return sha256Canonical(policy);
}

type ProvenanceProjectionInput = Omit<AgenticCorpusProvenance, "provenanceDigest">;

export function agenticCorpusProvenanceProjection(value: ProvenanceProjectionInput) {
  return {
    schemaVersion: value.schemaVersion,
    domain: value.domain,
    trustPolicyDigest: value.trustPolicyDigest,
    caseId: value.caseId,
    caseDigest: value.caseDigest,
    source: value.source,
    execution: value.execution,
    authorKeyId: value.author.keyId,
    reviewerKeyId: value.reviewer.keyId,
  };
}

export function agenticCorpusProvenanceSigningBytes(value: ProvenanceProjectionInput): Uint8Array {
  return Buffer.from(
    `TESTFORGE_AGENTIC_CORPUS_PROVENANCE_V1\0${canonicalize(agenticCorpusProvenanceProjection(value))}`,
    "utf8",
  );
}

export function agenticCorpusProvenanceDigest(value: ProvenanceProjectionInput): string {
  return sha256Canonical({
    projection: agenticCorpusProvenanceProjection(value),
    authorSignature: value.author.signature,
    reviewerSignature: value.reviewer.signature,
  });
}

function strictBase64Url(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length > 0 && decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

function trustedKey(policy: AgenticCorpusTrustPolicy, keyId: string) {
  const entry = policy.keys.find((key) => key.keyId === keyId);
  if (entry === undefined) return null;
  const der = strictBase64Url(entry.publicKey.data);
  if (der === null) return null;
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    const canonicalDer = key.export({ format: "der", type: "spki" });
    if (!Buffer.isBuffer(canonicalDer) || !canonicalDer.equals(der)) return null;
    const derived = `sha256:${createHash("sha256").update(canonicalDer).digest("hex")}`;
    if (key.asymmetricKeyType !== "ed25519" || derived !== entry.keyId) return null;
    return { entry, key, canonicalKeyFingerprint: derived };
  } catch {
    return null;
  }
}

function allPolicyKeysValid(policy: AgenticCorpusTrustPolicy): boolean {
  return policy.keys.every((entry) => trustedKey(policy, entry.keyId) !== null);
}

export function verifyAgenticCorpusAllocationCommitmentSignatures(
  commitment: AgenticCorpusAllocationCommitment,
  policy: AgenticCorpusTrustPolicy,
  expectedPolicyDigest: string,
): { valid: boolean; principalsDistinct: boolean } {
  const authorSigner = commitment.signers.find((item) => item.role === "AUTHOR");
  const reviewerSigner = commitment.signers.find((item) => item.role === "REVIEWER");
  const author = authorSigner === undefined ? null : trustedKey(policy, authorSigner.keyId);
  const reviewer = reviewerSigner === undefined ? null : trustedKey(policy, reviewerSigner.keyId);
  const principalsDistinct =
    author !== null &&
    reviewer !== null &&
    author.entry.keyId !== reviewer.entry.keyId &&
    author.entry.subjectId !== reviewer.entry.subjectId &&
    author.canonicalKeyFingerprint !== reviewer.canonicalKeyFingerprint;
  const sourcePolicies = commitment.caseSet.map((subject) =>
    policy.sources.find(
      (source) =>
        source.sourceId === subject.sourceId &&
        source.sourceIdentityDigest === subject.sourceIdentityDigest,
    ),
  );
  const authorTrusted =
    author?.entry.roles.includes("AUTHOR") === true &&
    sourcePolicies.every(
      (source) => source?.authorizedAuthorSubjectIds.includes(author.entry.subjectId) === true,
    );
  const reviewerTrusted =
    reviewer?.entry.roles.includes("REVIEWER") === true &&
    sourcePolicies.every(
      (source) => source?.authorizedReviewerSubjectIds.includes(reviewer.entry.subjectId) === true,
    );
  const bytes = agenticCorpusAllocationCommitmentSigningBytes(commitment);
  const authorSignature =
    authorSigner === undefined ? null : strictBase64Url(authorSigner.signature);
  const reviewerSignature =
    reviewerSigner === undefined ? null : strictBase64Url(reviewerSigner.signature);
  const policyValid =
    policy.policyDigest === expectedPolicyDigest &&
    policy.policyDigest ===
      agenticCorpusTrustPolicyDigest({
        schemaVersion: policy.schemaVersion,
        policyId: policy.policyId,
        keys: policy.keys,
        sources: policy.sources,
      }) &&
    allPolicyKeysValid(policy);
  return {
    principalsDistinct,
    valid:
      policyValid &&
      principalsDistinct &&
      authorTrusted &&
      reviewerTrusted &&
      author !== null &&
      reviewer !== null &&
      authorSignature !== null &&
      reviewerSignature !== null &&
      verifySignature(null, bytes, author.key, authorSignature) &&
      verifySignature(null, bytes, reviewer.key, reviewerSignature),
  };
}

export function replayAgenticCorpusProvenance(
  caseValue: unknown,
  sidecarValue: unknown,
  policyValue: unknown,
  expectedPolicyDigest: string,
): AgenticCorpusProvenanceReplayResult {
  const rails = {
    schemaValid: false,
    canonicalCaseDigestValid: false,
    policyDigestValid: false,
    sourceRegistered: false,
    sourceBindingValid: false,
    executionReceiptDigestValid: false,
    authorTrusted: false,
    reviewerTrusted: false,
    principalsDistinct: false,
    authorSignatureValid: false,
    reviewerSignatureValid: false,
    provenanceDigestValid: false,
  };
  let corpusCase: AgenticCorpusCase;
  let sidecar: AgenticCorpusProvenance;
  let policy: AgenticCorpusTrustPolicy;
  try {
    corpusCase = parseAgenticCorpusCase(caseValue);
    sidecar = parseAgenticCorpusProvenance(sidecarValue);
    policy = parseAgenticCorpusTrustPolicy(policyValue);
    rails.schemaValid = true;
  } catch {
    return { valid: false, ...rails };
  }

  rails.canonicalCaseDigestValid = sidecar.caseDigest === sha256Canonical(corpusCase);
  rails.policyDigestValid =
    SHA256_DIGEST.test(expectedPolicyDigest) &&
    policy.policyDigest === expectedPolicyDigest &&
    policy.policyDigest ===
      agenticCorpusTrustPolicyDigest({
        schemaVersion: policy.schemaVersion,
        policyId: policy.policyId,
        keys: policy.keys,
        sources: policy.sources,
      }) &&
    allPolicyKeysValid(policy);
  const source = policy.sources.find((entry) => entry.sourceId === sidecar.source.sourceId);
  rails.sourceRegistered = source !== undefined;
  rails.sourceBindingValid =
    source !== undefined &&
    sidecar.trustPolicyDigest === expectedPolicyDigest &&
    sidecar.caseId === corpusCase.caseId &&
    sidecar.source.sourceId === corpusCase.sourceId &&
    sidecar.source.sourceRevision === corpusCase.sourceRevision &&
    sidecar.source.sourceIdentityDigest === source.sourceIdentityDigest;
  rails.executionReceiptDigestValid =
    sidecar.execution.receiptDigest ===
    sha256Canonical({
      protocolId: sidecar.execution.protocolId,
      evidenceDigests: sidecar.execution.evidenceDigests,
    });

  const author = trustedKey(policy, sidecar.author.keyId);
  const reviewer = trustedKey(policy, sidecar.reviewer.keyId);
  rails.authorTrusted =
    author?.entry.roles.includes("AUTHOR") === true &&
    source?.authorizedAuthorSubjectIds.includes(author.entry.subjectId) === true;
  rails.reviewerTrusted =
    reviewer?.entry.roles.includes("REVIEWER") === true &&
    source?.authorizedReviewerSubjectIds.includes(reviewer.entry.subjectId) === true;
  rails.principalsDistinct =
    author !== null &&
    reviewer !== null &&
    author.entry.keyId !== reviewer.entry.keyId &&
    author.entry.subjectId !== reviewer.entry.subjectId &&
    author.canonicalKeyFingerprint !== reviewer.canonicalKeyFingerprint;
  const bytes = agenticCorpusProvenanceSigningBytes(sidecar);
  const authorSignature = strictBase64Url(sidecar.author.signature);
  const reviewerSignature = strictBase64Url(sidecar.reviewer.signature);
  rails.authorSignatureValid =
    author !== null &&
    authorSignature !== null &&
    verifySignature(null, bytes, author.key, authorSignature);
  rails.reviewerSignatureValid =
    reviewer !== null &&
    reviewerSignature !== null &&
    verifySignature(null, bytes, reviewer.key, reviewerSignature);
  rails.provenanceDigestValid = sidecar.provenanceDigest === agenticCorpusProvenanceDigest(sidecar);
  return { valid: Object.values(rails).every(Boolean), ...rails };
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}

function fraction(detected: unknown, total: unknown): [number, number] {
  const validDetected = count(detected);
  const validTotal = count(total);
  if (validTotal === 0 || validDetected > validTotal) return invalid();
  return [validDetected, validTotal];
}

function parseH1(value: unknown): NonNullable<AgenticCorpusCase["h1"]> {
  const item = record(value);
  exactKeys(item, ["equalTargetStrength", "baselineWarmP95Us", "profileWarmP95Us"]);
  return {
    equalTargetStrength: boolean(item.equalTargetStrength),
    baselineWarmP95Us: count(item.baselineWarmP95Us),
    profileWarmP95Us: count(item.profileWarmP95Us),
  };
}

function parseH2(value: unknown): NonNullable<AgenticCorpusCase["h2"]> {
  const item = record(value);
  exactKeys(item, [
    "baselineNeutralSurvived",
    "baselineNeutralTotal",
    "profileNeutralSurvived",
    "profileNeutralTotal",
  ]);
  const [baselineNeutralSurvived, baselineNeutralTotal] = fraction(
    item.baselineNeutralSurvived,
    item.baselineNeutralTotal,
  );
  const [profileNeutralSurvived, profileNeutralTotal] = fraction(
    item.profileNeutralSurvived,
    item.profileNeutralTotal,
  );
  return {
    baselineNeutralSurvived,
    baselineNeutralTotal,
    profileNeutralSurvived,
    profileNeutralTotal,
  };
}

function parseH3(value: unknown): NonNullable<AgenticCorpusCase["h3"]> {
  const item = record(value);
  exactKeys(item, [
    "equalBudget",
    "baselineHeldOutFaultsDetected",
    "baselineHeldOutFaultsTotal",
    "profileHeldOutFaultsDetected",
    "profileHeldOutFaultsTotal",
  ]);
  const [baselineHeldOutFaultsDetected, baselineHeldOutFaultsTotal] = fraction(
    item.baselineHeldOutFaultsDetected,
    item.baselineHeldOutFaultsTotal,
  );
  const [profileHeldOutFaultsDetected, profileHeldOutFaultsTotal] = fraction(
    item.profileHeldOutFaultsDetected,
    item.profileHeldOutFaultsTotal,
  );
  return {
    equalBudget: boolean(item.equalBudget),
    baselineHeldOutFaultsDetected,
    baselineHeldOutFaultsTotal,
    profileHeldOutFaultsDetected,
    profileHeldOutFaultsTotal,
  };
}

function parseH4(value: unknown): NonNullable<AgenticCorpusCase["h4"]> {
  const item = record(value);
  exactKeys(item, [
    "reviewedReduction",
    "baselineHistoricalFaultsDetected",
    "baselineHistoricalFaultsTotal",
    "profileHistoricalFaultsDetected",
    "profileHistoricalFaultsTotal",
    "baselineCostUs",
    "profileCostUs",
    "baselineMutantCount",
    "profileMutantCount",
  ]);
  const [baselineHistoricalFaultsDetected, baselineHistoricalFaultsTotal] = fraction(
    item.baselineHistoricalFaultsDetected,
    item.baselineHistoricalFaultsTotal,
  );
  const [profileHistoricalFaultsDetected, profileHistoricalFaultsTotal] = fraction(
    item.profileHistoricalFaultsDetected,
    item.profileHistoricalFaultsTotal,
  );
  return {
    reviewedReduction: boolean(item.reviewedReduction),
    baselineHistoricalFaultsDetected,
    baselineHistoricalFaultsTotal,
    profileHistoricalFaultsDetected,
    profileHistoricalFaultsTotal,
    baselineCostUs: count(item.baselineCostUs),
    profileCostUs: count(item.profileCostUs),
    baselineMutantCount: count(item.baselineMutantCount),
    profileMutantCount: count(item.profileMutantCount),
  };
}

export function parseAgenticCorpusCase(value: unknown): AgenticCorpusCase {
  const item = record(value);
  exactKeys(
    item,
    ["schemaVersion", "caseId", "sourceId", "sourceRevision"],
    ["h1", "h2", "h3", "h4"],
  );
  if (item.schemaVersion !== SCHEMA_VERSION) invalid();
  const parsed: AgenticCorpusCase = {
    schemaVersion: SCHEMA_VERSION,
    caseId: portableIdentifier(item.caseId),
    sourceId: portableIdentifier(item.sourceId),
    sourceRevision: digest(item.sourceRevision),
  };
  if (item.h1 !== undefined) parsed.h1 = parseH1(item.h1);
  if (item.h2 !== undefined) parsed.h2 = parseH2(item.h2);
  if (item.h3 !== undefined) parsed.h3 = parseH3(item.h3);
  if (item.h4 !== undefined) parsed.h4 = parseH4(item.h4);
  return parsed;
}

function compareIdentifier(left: AgenticCorpusCase, right: AgenticCorpusCase): number {
  return left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0;
}

async function readSplit(
  directory: string,
  policy: AgenticCorpusTrustPolicy,
  expectedPolicyDigest: string,
): Promise<LoadedCase[]> {
  let entries: Dirent[];
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new AgenticCorpusError("SPLIT_DIRECTORY_INVALID");
    }
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof AgenticCorpusError) throw error;
    throw new AgenticCorpusError("SPLIT_DIRECTORY_INVALID", { cause: error });
  }

  const caseNames = new Set(
    entries.filter((entry) => entry.name.endsWith(CASE_SUFFIX)).map((entry) => entry.name),
  );
  const portableCaseNames = new Set<string>();
  const portableProvenanceNames = new Set<string>();
  for (const entry of entries) {
    const suffix = entry.name.endsWith(CASE_SUFFIX)
      ? CASE_SUFFIX
      : entry.name.endsWith(".provenance.json")
        ? ".provenance.json"
        : null;
    if (suffix === null) continue;
    const key = portablePathKey(entry.name.slice(0, -suffix.length));
    const seen = suffix === CASE_SUFFIX ? portableCaseNames : portableProvenanceNames;
    if (seen.has(key)) throw new AgenticCorpusError("PORTABLE_CORPUS_FILE_COLLISION");
    seen.add(key);
  }
  if (
    entries.some(
      (entry) =>
        entry.name.endsWith(".provenance.json") &&
        !caseNames.has(`${entry.name.slice(0, -".provenance.json".length)}.case.json`),
    )
  ) {
    throw new AgenticCorpusError("PROVENANCE_FILE_ORPHANED");
  }
  const cases: LoadedCase[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    if (!entry.name.endsWith(CASE_SUFFIX)) continue;
    if (!entry.isFile()) throw new AgenticCorpusError("CASE_FILE_INVALID");
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path.join(directory, entry.name), "utf8")) as unknown;
    } catch (error) {
      throw new AgenticCorpusError("CASE_JSON_INVALID", { cause: error });
    }
    const corpusCase = parseAgenticCorpusCase(value);
    const basename = entry.name.slice(0, -CASE_SUFFIX.length);
    const fileBasenameKey = portablePathKey(basename);
    if (fileBasenameKey !== portablePathKey(corpusCase.caseId)) {
      throw new AgenticCorpusError("CASE_FILE_ID_MISMATCH");
    }
    const provenancePath = path.join(directory, `${basename}.provenance.json`);
    let provenanceText: string;
    let provenanceValue: unknown;
    try {
      const metadata = await lstat(provenancePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new AgenticCorpusError("PROVENANCE_FILE_INVALID");
      }
      const [directoryReal, provenanceReal] = await Promise.all([
        realpath(directory),
        realpath(provenancePath),
      ]);
      if (path.dirname(provenanceReal) !== directoryReal) {
        throw new AgenticCorpusError("PROVENANCE_FILE_INVALID");
      }
      provenanceText = await readFile(provenancePath, "utf8");
      provenanceValue = JSON.parse(provenanceText) as unknown;
    } catch (error) {
      if (error instanceof AgenticCorpusError) throw error;
      throw new AgenticCorpusError("PROVENANCE_MISSING_OR_INVALID", { cause: error });
    }
    if (`${canonicalize(provenanceValue)}\n` !== provenanceText) {
      throw new AgenticCorpusError("PROVENANCE_JSON_NONCANONICAL");
    }
    let provenance: AgenticCorpusProvenance;
    try {
      provenance = parseAgenticCorpusProvenance(provenanceValue);
    } catch (error) {
      throw new AgenticCorpusError("PROVENANCE_INVALID", { cause: error });
    }
    const replay = replayAgenticCorpusProvenance(
      corpusCase,
      provenance,
      policy,
      expectedPolicyDigest,
    );
    if (!replay.valid) throw new AgenticCorpusError("PROVENANCE_INVALID");
    cases.push({
      ...corpusCase,
      provenanceDigest: provenance.provenanceDigest,
      sourceIdentityDigest: provenance.source.sourceIdentityDigest,
      fileBasenameKey,
    });
  }
  return cases.sort(compareIdentifier);
}

function trustedPolicy(options: AgenticCorpusTrustOptions): AgenticCorpusTrustPolicy {
  let policy: AgenticCorpusTrustPolicy;
  try {
    policy = parseAgenticCorpusTrustPolicy(options.policy);
  } catch (error) {
    throw new AgenticCorpusError("PROVENANCE_POLICY_INVALID", { cause: error });
  }
  const computed = agenticCorpusTrustPolicyDigest({
    schemaVersion: policy.schemaVersion,
    policyId: policy.policyId,
    keys: policy.keys,
    sources: policy.sources,
  });
  if (
    !SHA256_DIGEST.test(options.expectedPolicyDigest) ||
    policy.policyDigest !== options.expectedPolicyDigest ||
    policy.policyDigest !== computed ||
    !allPolicyKeysValid(policy)
  ) {
    throw new AgenticCorpusError("PROVENANCE_POLICY_DIGEST_MISMATCH");
  }
  return policy;
}

async function loadCorpus(root: string, options: AgenticCorpusTrustOptions): Promise<LoadedCorpus> {
  const policy = trustedPolicy(options);
  const publicDirectory = path.join(root, "public");
  const privateDirectory = path.join(root, "private");
  try {
    const [rootReal, publicReal, privateReal] = await Promise.all([
      realpath(root),
      realpath(publicDirectory),
      realpath(privateDirectory),
    ]);
    if (
      publicReal === privateReal ||
      path.dirname(publicReal) !== rootReal ||
      path.dirname(privateReal) !== rootReal
    ) {
      throw new AgenticCorpusError("SPLITS_NOT_PHYSICALLY_SEPARATE");
    }
  } catch (error) {
    if (error instanceof AgenticCorpusError) throw error;
    throw new AgenticCorpusError("SPLIT_DIRECTORY_INVALID", { cause: error });
  }

  // Public precedes private so two invalid splits always yield the same operator-visible reason.
  const publicCases = await readSplit(publicDirectory, policy, options.expectedPolicyDigest);
  const holdoutCases = await readSplit(privateDirectory, policy, options.expectedPolicyDigest);
  const identifiers = new Map<string, string>();
  const basenames = new Set<string>();
  for (const item of [...publicCases, ...holdoutCases]) {
    const identifierKey = portablePathKey(item.caseId);
    const existingIdentifier = identifiers.get(identifierKey);
    if (existingIdentifier !== undefined) {
      throw new AgenticCorpusError(
        existingIdentifier === item.caseId ? "DUPLICATE_CASE_ID" : "PORTABLE_CASE_ID_COLLISION",
      );
    }
    if (basenames.has(item.fileBasenameKey)) {
      throw new AgenticCorpusError("PORTABLE_CORPUS_FILE_COLLISION");
    }
    identifiers.set(identifierKey, item.caseId);
    basenames.add(item.fileBasenameKey);
  }
  return { publicCases, holdoutCases };
}

function compareFractions(
  leftNumerator: number,
  leftDenominator: number,
  rightNumerator: number,
  rightDenominator: number,
): -1 | 0 | 1 {
  const left = BigInt(leftNumerator) * BigInt(rightDenominator);
  const right = BigInt(rightNumerator) * BigInt(leftDenominator);
  return left < right ? -1 : left > right ? 1 : 0;
}

function insufficient(reasonCode: string): HypothesisOutcome {
  return { outcome: "INSUFFICIENT", reasonCodes: [reasonCode] };
}

function evaluateH1(item: AgenticCorpusCase): HypothesisOutcome {
  if (item.h1 === undefined) return insufficient("HYPOTHESIS_EVIDENCE_MISSING");
  if (!item.h1.equalTargetStrength) return insufficient("TARGET_STRENGTH_NOT_EQUAL");
  return item.h1.profileWarmP95Us < item.h1.baselineWarmP95Us
    ? { outcome: "SUPPORT", reasonCodes: ["PROFILE_WARM_P95_LOWER"] }
    : { outcome: "OPPOSITION", reasonCodes: ["PROFILE_WARM_P95_NOT_LOWER"] };
}

function evaluateH2(item: AgenticCorpusCase): HypothesisOutcome {
  if (item.h2 === undefined) return insufficient("HYPOTHESIS_EVIDENCE_MISSING");
  const comparison = compareFractions(
    item.h2.profileNeutralSurvived,
    item.h2.profileNeutralTotal,
    item.h2.baselineNeutralSurvived,
    item.h2.baselineNeutralTotal,
  );
  return comparison > 0
    ? { outcome: "SUPPORT", reasonCodes: ["PROFILE_NEUTRAL_SURVIVAL_HIGHER"] }
    : { outcome: "OPPOSITION", reasonCodes: ["PROFILE_NEUTRAL_SURVIVAL_NOT_HIGHER"] };
}

function evaluateH3(item: AgenticCorpusCase): HypothesisOutcome {
  if (item.h3 === undefined) return insufficient("HYPOTHESIS_EVIDENCE_MISSING");
  if (!item.h3.equalBudget) return insufficient("BUDGET_NOT_EQUAL");
  const comparison = compareFractions(
    item.h3.profileHeldOutFaultsDetected,
    item.h3.profileHeldOutFaultsTotal,
    item.h3.baselineHeldOutFaultsDetected,
    item.h3.baselineHeldOutFaultsTotal,
  );
  return comparison >= 0
    ? { outcome: "SUPPORT", reasonCodes: ["PROFILE_HELD_OUT_RECALL_NON_INFERIOR"] }
    : { outcome: "OPPOSITION", reasonCodes: ["PROFILE_HELD_OUT_RECALL_INFERIOR"] };
}

function evaluateH4(item: AgenticCorpusCase): HypothesisOutcome {
  if (item.h4 === undefined) return insufficient("HYPOTHESIS_EVIDENCE_MISSING");
  if (!item.h4.reviewedReduction) return insufficient("REDUCTION_NOT_REVIEWED");
  const reasons: string[] = [];
  const recallComparison = compareFractions(
    item.h4.profileHistoricalFaultsDetected,
    item.h4.profileHistoricalFaultsTotal,
    item.h4.baselineHistoricalFaultsDetected,
    item.h4.baselineHistoricalFaultsTotal,
  );
  if (recallComparison < 0) reasons.push("PROFILE_HISTORICAL_RECALL_INFERIOR");
  if (item.h4.profileCostUs >= item.h4.baselineCostUs) reasons.push("PROFILE_COST_NOT_LOWER");
  if (item.h4.profileMutantCount >= item.h4.baselineMutantCount) {
    reasons.push("PROFILE_MUTANT_COUNT_NOT_LOWER");
  }
  return reasons.length === 0
    ? { outcome: "SUPPORT", reasonCodes: ["REVIEWED_REDUCTION_SUPPORTS_H4"] }
    : { outcome: "OPPOSITION", reasonCodes: reasons };
}

function evaluateCase(item: AgenticCorpusCase): Record<Hypothesis, HypothesisOutcome> {
  return { H1: evaluateH1(item), H2: evaluateH2(item), H3: evaluateH3(item), H4: evaluateH4(item) };
}

function isEvaluable(item: AgenticCorpusCase, hypothesis: Hypothesis): boolean {
  switch (hypothesis) {
    case "H1":
      return item.h1?.equalTargetStrength === true;
    case "H2":
      return item.h2 !== undefined;
    case "H3":
      return item.h3?.equalBudget === true;
    case "H4":
      return item.h4?.reviewedReduction === true;
  }
}

function statusFor(corpus: LoadedCorpus): AgenticCorpusStatus {
  const allCases = [...corpus.publicCases, ...corpus.holdoutCases];
  const evaluable = Object.fromEntries(
    HYPOTHESES.map((hypothesis) => [
      hypothesis,
      allCases.filter((item) => isEvaluable(item, hypothesis)).length,
    ]),
  ) as Record<Hypothesis, number>;
  const counts = {
    totalCases: allCases.length,
    publicCases: corpus.publicCases.length,
    holdoutCases: corpus.holdoutCases.length,
    distinctSources: new Set(allCases.map((item) => item.sourceIdentityDigest)).size,
    evaluable,
  };
  const failedGates: ReadinessGate[] = [];
  if (counts.totalCases < 20) failedGates.push("MINIMUM_CASES_NOT_MET");
  if (counts.distinctSources < 3) failedGates.push("MINIMUM_SOURCES_NOT_MET");
  if (counts.publicCases < 1) failedGates.push("PUBLIC_SPLIT_EMPTY");
  if (counts.holdoutCases < 1) failedGates.push("HOLDOUT_SPLIT_EMPTY");
  for (const hypothesis of HYPOTHESES) {
    if (evaluable[hypothesis] === 0) failedGates.push(`${hypothesis}_EVIDENCE_MISSING`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    status: failedGates.length === 0 ? "READY" : "NOT_READY",
    failedGates,
    counts,
  };
}

function policyRequiredStatus(): AgenticCorpusStatus {
  return {
    schemaVersion: SCHEMA_VERSION,
    status: "NOT_READY",
    failedGates: ["PROVENANCE_POLICY_REQUIRED"],
    counts: {
      totalCases: 0,
      publicCases: 0,
      holdoutCases: 0,
      distinctSources: 0,
      evaluable: { H1: 0, H2: 0, H3: 0, H4: 0 },
    },
  };
}

export async function inspectAgenticCorpus(
  root: string,
  options?: AgenticCorpusTrustOptions,
): Promise<AgenticCorpusStatus> {
  if (options === undefined) return policyRequiredStatus();
  return statusFor(await loadCorpus(root, options));
}

function aggregate(outcomes: readonly HypothesisOutcome[]): Aggregate {
  return {
    support: outcomes.filter((item) => item.outcome === "SUPPORT").length,
    opposition: outcomes.filter((item) => item.outcome === "OPPOSITION").length,
    insufficient: outcomes.filter((item) => item.outcome === "INSUFFICIENT").length,
  };
}

export async function evaluateAgenticCorpusPublic(
  root: string,
  options?: AgenticCorpusTrustOptions,
) {
  if (options === undefined) return policyRequiredStatus();
  const corpus = await loadCorpus(root, options);
  const readiness = statusFor(corpus);
  if (readiness.status === "NOT_READY") return readiness;
  const cases = corpus.publicCases.map((item) => {
    const hypotheses = evaluateCase(item);
    const outcomes = Object.values(hypotheses);
    return {
      caseId: item.caseId,
      sourceId: item.sourceId,
      sourceRevision: item.sourceRevision,
      provenanceDigest: item.provenanceDigest,
      hypotheses,
      score: {
        numerator: outcomes.filter((outcome) => outcome.outcome === "SUPPORT").length,
        denominator: outcomes.filter((outcome) => outcome.outcome !== "INSUFFICIENT").length,
      },
    };
  });
  const allOutcomes = cases.flatMap((item) => Object.values(item.hypotheses));
  return {
    schemaVersion: SCHEMA_VERSION,
    status: "EVALUATED" as const,
    split: "PUBLIC" as const,
    score: {
      numerator: allOutcomes.filter((outcome) => outcome.outcome === "SUPPORT").length,
      denominator: allOutcomes.filter((outcome) => outcome.outcome !== "INSUFFICIENT").length,
    },
    hypotheses: Object.fromEntries(
      HYPOTHESES.map((hypothesis) => [
        hypothesis,
        aggregate(cases.map((item) => item.hypotheses[hypothesis])),
      ]),
    ) as Record<Hypothesis, Aggregate>,
    cases,
  };
}

export async function evaluateAgenticCorpusHoldout(
  root: string,
  options?: AgenticCorpusTrustOptions,
) {
  if (options === undefined) {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: "NOT_READY" as const,
      failedGates: ["CORPUS_NOT_READY" as const],
    };
  }
  let corpus: LoadedCorpus;
  try {
    corpus = await loadCorpus(root, options);
  } catch (error) {
    if (error instanceof AgenticCorpusError) {
      return {
        schemaVersion: SCHEMA_VERSION,
        status: "INVALID_CORPUS" as const,
        reasonCodes: ["CORPUS_INVALID" as const],
      };
    }
    throw error;
  }
  const readiness = statusFor(corpus);
  if (readiness.status === "NOT_READY") {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: "NOT_READY" as const,
      failedGates: ["CORPUS_NOT_READY" as const],
    };
  }
  const outcomes = corpus.holdoutCases.map(evaluateCase);
  return {
    schemaVersion: SCHEMA_VERSION,
    status: "EVALUATED" as const,
    split: "HOLDOUT" as const,
    hypotheses: Object.fromEntries(
      HYPOTHESES.map((hypothesis) => [
        hypothesis,
        aggregate(outcomes.map((item) => item[hypothesis])),
      ]),
    ) as Record<Hypothesis, Aggregate>,
  };
}
