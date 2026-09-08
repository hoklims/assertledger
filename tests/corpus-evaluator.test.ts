import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { canonicalize, sha256Canonical } from "../src/core/index.js";
import { parseAgenticCorpusTrustPolicy } from "../src/contracts/index.js";
import {
  agenticCorpusProvenanceDigest,
  agenticCorpusProvenanceSigningBytes,
  agenticCorpusTrustPolicyDigest,
  evaluateAgenticCorpusHoldout,
  evaluateAgenticCorpusPublic,
  inspectAgenticCorpus,
  parseAgenticCorpusCase,
  replayAgenticCorpusProvenance,
} from "../src/evaluation/agentic-corpus.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function digest(character = "a"): string {
  return `sha256:${character.repeat(64)}`;
}

function caseFixture(index = 0, sourceId = `source-${index % 3}`) {
  return {
    schemaVersion: "1.0.0",
    caseId: `case-${index}`,
    sourceId,
    sourceRevision: digest(String(index % 10)),
    h1: {
      equalTargetStrength: true,
      baselineWarmP95Us: 101,
      profileWarmP95Us: 100,
    },
    h2: {
      baselineNeutralSurvived: 1,
      baselineNeutralTotal: 3,
      profileNeutralSurvived: 2,
      profileNeutralTotal: 5,
    },
    h3: {
      equalBudget: true,
      baselineHeldOutFaultsDetected: 1,
      baselineHeldOutFaultsTotal: 3,
      profileHeldOutFaultsDetected: 2,
      profileHeldOutFaultsTotal: 5,
    },
    h4: {
      reviewedReduction: true,
      baselineHistoricalFaultsDetected: 1,
      baselineHistoricalFaultsTotal: 2,
      profileHistoricalFaultsDetected: 2,
      profileHistoricalFaultsTotal: 4,
      baselineCostUs: 101,
      profileCostUs: 100,
      baselineMutantCount: 11,
      profileMutantCount: 10,
    },
  };
}

async function corpusRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "testforge-agentic-corpus-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "public"), { recursive: true });
  await mkdir(path.join(root, "private"), { recursive: true });
  return root;
}

async function writeCase(root: string, split: "public" | "private", value: unknown) {
  const record = value as { caseId: string };
  await writeFile(
    path.join(root, split, `${record.caseId}.case.json`),
    `${JSON.stringify(value)}\n`,
  );
}

function trustFixture(sharedSourceIdentity = false) {
  const author = generateKeyPairSync("ed25519");
  const reviewer = generateKeyPairSync("ed25519");
  const keyRecord = (pair: typeof author, subjectId: string, role: "AUTHOR" | "REVIEWER") => {
    const der = pair.publicKey.export({ format: "der", type: "spki" });
    return {
      keyId: `sha256:${createHash("sha256").update(der).digest("hex")}`,
      subjectId,
      roles: [role] as Array<"AUTHOR" | "REVIEWER">,
      publicKey: {
        algorithm: "Ed25519" as const,
        format: "SPKI_DER_BASE64URL" as const,
        data: der.toString("base64url"),
      },
    };
  };
  const authorRecord = keyRecord(author, "author-subject", "AUTHOR");
  const reviewerRecord = keyRecord(reviewer, "reviewer-subject", "REVIEWER");
  const unsignedPolicy = {
    schemaVersion: "1.0.0" as const,
    policyId: "conformance-policy",
    keys: [authorRecord, reviewerRecord],
    sources: [0, 1, 2].map((index) => ({
      sourceId: `source-${index}`,
      sourceIdentityDigest: digest(sharedSourceIdentity ? "e" : String(index + 4)),
      authorizedAuthorSubjectIds: [authorRecord.subjectId],
      authorizedReviewerSubjectIds: [reviewerRecord.subjectId],
    })),
  };
  const policy = {
    ...unsignedPolicy,
    policyDigest: agenticCorpusTrustPolicyDigest(unsignedPolicy),
  };
  return {
    policy,
    expectedPolicyDigest: policy.policyDigest,
    author,
    reviewer,
    authorRecord,
    reviewerRecord,
  };
}

type TrustFixture = ReturnType<typeof trustFixture>;

function provenanceFor(value: ReturnType<typeof caseFixture>, trust: TrustFixture) {
  const source = trust.policy.sources.find((entry) => entry.sourceId === value.sourceId);
  assert.ok(source);
  const execution = {
    status: "EXECUTED" as const,
    protocolId: "conformance-protocol",
    evidenceDigests: [digest("f")],
    receiptDigest: sha256Canonical({
      protocolId: "conformance-protocol",
      evidenceDigests: [digest("f")],
    }),
  };
  const unsigned = {
    schemaVersion: "1.0.0" as const,
    domain: "TESTFORGE_AGENTIC_CORPUS_CASE_V1" as const,
    trustPolicyDigest: trust.policy.policyDigest,
    caseId: value.caseId,
    caseDigest: sha256Canonical(parseAgenticCorpusCase(value)),
    source: {
      sourceId: value.sourceId,
      sourceRevision: value.sourceRevision,
      sourceIdentityDigest: source.sourceIdentityDigest,
    },
    execution,
    author: { keyId: trust.authorRecord.keyId, signature: "pending" },
    reviewer: { keyId: trust.reviewerRecord.keyId, signature: "pending" },
  };
  return sealProvenance(unsigned, trust);
}

function sealProvenance<T extends Parameters<typeof agenticCorpusProvenanceSigningBytes>[0]>(
  unsigned: T,
  trust: TrustFixture,
) {
  const bytes = agenticCorpusProvenanceSigningBytes(unsigned);
  const signed = {
    ...unsigned,
    author: {
      ...unsigned.author,
      signature: sign(null, bytes, trust.author.privateKey).toString("base64url"),
    },
    reviewer: {
      ...unsigned.reviewer,
      signature: sign(null, bytes, trust.reviewer.privateKey).toString("base64url"),
    },
  };
  return { ...signed, provenanceDigest: agenticCorpusProvenanceDigest(signed) };
}

async function writeSignedCase(
  root: string,
  split: "public" | "private",
  value: ReturnType<typeof caseFixture>,
  trust: TrustFixture,
) {
  await writeCase(root, split, value);
  const provenance = provenanceFor(value, trust);
  await writeFile(
    path.join(root, split, `${value.caseId}.provenance.json`),
    `${canonicalize(provenance)}\n`,
  );
  return provenance;
}

async function readyCorpus(sharedSourceIdentity = false) {
  const root = await corpusRoot();
  const trust = trustFixture(sharedSourceIdentity);
  for (let index = 0; index < 19; index += 1) {
    await writeSignedCase(root, "public", caseFixture(index), trust);
  }
  await writeSignedCase(root, "private", caseFixture(19), trust);
  return { root, trust };
}

async function invokeCli(args: string[]) {
  const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.join(process.cwd(), "scripts", "evaluate-agentic-profile-corpus.ts");
  const { FORCE_COLOR: _forceColor, NO_COLOR: _noColor, ...environment } = process.env;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, script, ...args], {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function trustCliArgs(root: string, trust: TrustFixture): Promise<string[]> {
  const policyPath = path.join(root, "trust-policy.json");
  await writeFile(policyPath, `${canonicalize(trust.policy)}\n`);
  return ["--trust-policy", policyPath, "--trust-policy-digest", trust.expectedPolicyDigest];
}

describe("agentic profile corpus evaluator", () => {
  it("strictly validates portable identifiers, digests, counts, and unknown fields", () => {
    assert.equal(parseAgenticCorpusCase(caseFixture()).caseId, "case-0");

    for (const invalid of [
      { ...caseFixture(), caseId: "bad/id" },
      { ...caseFixture(), sourceRevision: "main" },
      { ...caseFixture(), extra: true },
      { ...caseFixture(), h2: { ...caseFixture().h2, baselineNeutralTotal: 0 } },
      { ...caseFixture(), h3: { ...caseFixture().h3, profileHeldOutFaultsDetected: 6 } },
      { ...caseFixture(), h4: { ...caseFixture().h4, extra: true } },
    ]) {
      assert.throws(() => parseAgenticCorpusCase(invalid), /AGENTIC_CORPUS_CASE_INVALID/);
    }
  });

  it("rejects duplicate case identifiers across public and holdout splits", async () => {
    const root = await corpusRoot();
    const trust = trustFixture();
    await writeSignedCase(root, "public", caseFixture(1), trust);
    await writeSignedCase(root, "private", caseFixture(1), trust);

    await assert.rejects(() => inspectAgenticCorpus(root, trust), /DUPLICATE_CASE_ID/);
  });

  it("compares rational rates with exact cross multiplication", async () => {
    const { root, trust } = await readyCorpus();
    const exact = caseFixture(0);
    exact.h2 = {
      baselineNeutralSurvived: 1,
      baselineNeutralTotal: 3,
      profileNeutralSurvived: 333_333_334,
      profileNeutralTotal: 1_000_000_000,
    };
    await writeSignedCase(root, "public", exact, trust);

    const report = await evaluateAgenticCorpusPublic(root, trust);
    assert.ok("cases" in report);
    const outcome = report.cases.find((item) => item.caseId === "case-0")?.hypotheses.H2;
    assert.deepEqual(outcome, {
      outcome: "SUPPORT",
      reasonCodes: ["PROFILE_NEUTRAL_SURVIVAL_HIGHER"],
    });
  });

  it("requires 20 cases, 3 sources, a public case, a holdout case, and evaluable H1-H4", async () => {
    const { root, trust } = await readyCorpus();

    const status = await inspectAgenticCorpus(root, trust);

    assert.equal(status.status, "READY");
    assert.deepEqual(status.failedGates, []);
    assert.deepEqual(status.counts, {
      totalCases: 20,
      publicCases: 19,
      holdoutCases: 1,
      distinctSources: 3,
      evaluable: { H1: 20, H2: 20, H3: 20, H4: 20 },
    });
  });

  it("returns rich public outcomes and scores without compensating insufficiency", async () => {
    const { root, trust } = await readyCorpus();
    const opposed = caseFixture(0);
    opposed.h1.equalTargetStrength = false;
    opposed.h3.profileHeldOutFaultsDetected = 1;
    opposed.h3.profileHeldOutFaultsTotal = 5;
    opposed.h4.profileCostUs = 102;
    opposed.h4.profileMutantCount = 12;
    await writeSignedCase(root, "public", opposed, trust);

    const report = await evaluateAgenticCorpusPublic(root, trust);
    assert.ok("cases" in report);
    const result = report.cases.find((item) => item.caseId === "case-0");
    assert.equal(report.status, "EVALUATED");
    assert.ok(result);
    assert.match(result.provenanceDigest, /^sha256:[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), /author|reviewer|subject|keyId/i);
    assert.deepEqual(result.hypotheses.H1, {
      outcome: "INSUFFICIENT",
      reasonCodes: ["TARGET_STRENGTH_NOT_EQUAL"],
    });
    assert.deepEqual(result.hypotheses.H3, {
      outcome: "OPPOSITION",
      reasonCodes: ["PROFILE_HELD_OUT_RECALL_INFERIOR"],
    });
    assert.deepEqual(result.hypotheses.H4, {
      outcome: "OPPOSITION",
      reasonCodes: ["PROFILE_COST_NOT_LOWER", "PROFILE_MUTANT_COUNT_NOT_LOWER"],
    });
    assert.deepEqual(result.score, { numerator: 1, denominator: 3 });
  });

  it("returns only aggregate holdout outcomes without gradient-bearing fields", async () => {
    const { root, trust } = await readyCorpus();

    const report = await evaluateAgenticCorpusHoldout(root, trust);
    const serialized = JSON.stringify(report);

    assert.deepEqual(report, {
      schemaVersion: "1.0.0",
      status: "EVALUATED",
      split: "HOLDOUT",
      hypotheses: {
        H1: { support: 1, opposition: 0, insufficient: 0 },
        H2: { support: 1, opposition: 0, insufficient: 0 },
        H3: { support: 1, opposition: 0, insufficient: 0 },
        H4: { support: 1, opposition: 0, insufficient: 0 },
      },
    });
    assert.doesNotMatch(serialized, /case-19|source-|WarmP95|Faults|CostUs|Mutant/i);
  });

  it("does not expose holdout counts or evaluability while the corpus is not ready", async () => {
    const root = await corpusRoot();
    await writeCase(root, "private", caseFixture(19));

    const report = await evaluateAgenticCorpusHoldout(root);

    assert.deepEqual(report, {
      schemaVersion: "1.0.0",
      status: "NOT_READY",
      failedGates: ["CORPUS_NOT_READY"],
    });
    assert.doesNotMatch(JSON.stringify(report), /count|source|case|evaluable|H1|H2|H3|H4/i);
  });

  it("fails the CLI closed with one deterministic INVALID_CORPUS document", async () => {
    const root = await corpusRoot();
    const trust = trustFixture();
    await writeFile(path.join(root, "public", "broken.case.json"), "{broken\n");
    await writeCase(root, "private", caseFixture(19));

    const result = await invokeCli(["status", root, ...(await trustCliArgs(root, trust))]);

    assert.equal(result.code, 4);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      schemaVersion: "1.0.0",
      status: "INVALID_CORPUS",
      reasonCodes: ["CASE_JSON_INVALID"],
    });
    assert.equal(result.stdout.trim().split("\n").length, 1);
  });

  it("reports an empty physical scaffold as NOT_READY with exit code 3", async () => {
    const root = await corpusRoot();
    const trust = trustFixture();

    const result = await invokeCli(["status", root, ...(await trustCliArgs(root, trust))]);

    assert.equal(result.code, 3);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "NOT_READY");
    assert.deepEqual(report.failedGates, [
      "MINIMUM_CASES_NOT_MET",
      "MINIMUM_SOURCES_NOT_MET",
      "PUBLIC_SPLIT_EMPTY",
      "HOLDOUT_SPLIT_EMPTY",
      "H1_EVIDENCE_MISSING",
      "H2_EVIDENCE_MISSING",
      "H3_EVIDENCE_MISSING",
      "H4_EVIDENCE_MISSING",
    ]);
  });

  it("replays a dual-signed sidecar and rejects redigested post-signature mutations", () => {
    const trust = trustFixture();
    const corpusCase = caseFixture();
    const provenance = provenanceFor(corpusCase, trust);

    assert.deepEqual(
      replayAgenticCorpusProvenance(
        corpusCase,
        provenance,
        trust.policy,
        trust.expectedPolicyDigest,
      ),
      {
        valid: true,
        schemaValid: true,
        canonicalCaseDigestValid: true,
        policyDigestValid: true,
        sourceRegistered: true,
        sourceBindingValid: true,
        executionReceiptDigestValid: true,
        authorTrusted: true,
        reviewerTrusted: true,
        principalsDistinct: true,
        authorSignatureValid: true,
        reviewerSignatureValid: true,
        provenanceDigestValid: true,
      },
    );

    for (const mutate of [
      (value: typeof provenance) => {
        value.source.sourceRevision = digest("8");
      },
      (value: typeof provenance) => {
        value.source.sourceIdentityDigest = digest("9");
      },
      (value: typeof provenance) => {
        value.execution.protocolId = "changed-protocol";
      },
      (value: typeof provenance) => {
        value.execution.evidenceDigests = [digest("7")];
      },
      (value: typeof provenance) => {
        value.execution.receiptDigest = digest("6");
      },
    ]) {
      const changed = structuredClone(provenance);
      mutate(changed);
      changed.provenanceDigest = agenticCorpusProvenanceDigest(changed);
      const replay = replayAgenticCorpusProvenance(
        corpusCase,
        changed,
        trust.policy,
        trust.expectedPolicyDigest,
      );
      assert.equal(replay.valid, false);
      assert.equal(replay.provenanceDigestValid, true);
      assert.equal(replay.authorSignatureValid, false);
      assert.equal(replay.reviewerSignatureValid, false);
    }

    const changedCase = structuredClone(corpusCase);
    changedCase.h1.profileWarmP95Us += 1;
    assert.equal(
      replayAgenticCorpusProvenance(
        changedCase,
        provenance,
        trust.policy,
        trust.expectedPolicyDigest,
      ).canonicalCaseDigestValid,
      false,
    );
  });

  it("requires the externally pinned policy and exact trusted, distinct principals", () => {
    const trust = trustFixture();
    const corpusCase = caseFixture();
    const provenance = provenanceFor(corpusCase, trust);
    const substituted = structuredClone(trust.policy);
    substituted.policyId = "substituted-policy";
    substituted.policyDigest = agenticCorpusTrustPolicyDigest({
      schemaVersion: substituted.schemaVersion,
      policyId: substituted.policyId,
      keys: substituted.keys,
      sources: substituted.sources,
    });
    assert.equal(
      replayAgenticCorpusProvenance(corpusCase, provenance, substituted, trust.expectedPolicyDigest)
        .policyDigestValid,
      false,
    );
    assert.equal(
      replayAgenticCorpusProvenance(corpusCase, provenance, trust.policy, digest("0"))
        .policyDigestValid,
      false,
    );

    const wrongRole = structuredClone(trust.policy);
    const wrongRoleKey = wrongRole.keys[0];
    assert.ok(wrongRoleKey);
    wrongRoleKey.roles = ["REVIEWER"];
    assert.equal(
      replayAgenticCorpusProvenance(corpusCase, provenance, wrongRole, trust.expectedPolicyDigest)
        .authorTrusted,
      false,
    );
    const unauthorized = structuredClone(trust.policy);
    const unauthorizedSource = unauthorized.sources[0];
    assert.ok(unauthorizedSource);
    unauthorizedSource.authorizedAuthorSubjectIds = ["somebody-else"];
    assert.equal(
      replayAgenticCorpusProvenance(
        corpusCase,
        provenance,
        unauthorized,
        trust.expectedPolicyDigest,
      ).authorTrusted,
      false,
    );
    const sameKey = structuredClone(provenance);
    sameKey.reviewer.keyId = sameKey.author.keyId;
    sameKey.provenanceDigest = agenticCorpusProvenanceDigest(sameKey);
    assert.equal(
      replayAgenticCorpusProvenance(corpusCase, sameKey, trust.policy, trust.expectedPolicyDigest)
        .principalsDistinct,
      false,
    );
    const sameSubject = structuredClone(trust.policy);
    const firstKey = sameSubject.keys[0];
    const secondKey = sameSubject.keys[1];
    assert.ok(firstKey && secondKey);
    secondKey.subjectId = firstKey.subjectId;
    for (const source of sameSubject.sources) {
      source.authorizedReviewerSubjectIds = [firstKey.subjectId];
    }
    sameSubject.policyDigest = agenticCorpusTrustPolicyDigest({
      schemaVersion: sameSubject.schemaVersion,
      policyId: sameSubject.policyId,
      keys: sameSubject.keys,
      sources: sameSubject.sources,
    });
    assert.doesNotThrow(() => parseAgenticCorpusTrustPolicy(sameSubject));
    const sameSubjectProvenance = sealProvenance(
      { ...provenance, trustPolicyDigest: sameSubject.policyDigest },
      trust,
    );
    const sameSubjectReplay = replayAgenticCorpusProvenance(
      corpusCase,
      sameSubjectProvenance,
      sameSubject,
      sameSubject.policyDigest,
    );
    assert.equal(sameSubjectReplay.schemaValid, true);
    assert.equal(sameSubjectReplay.authorTrusted, true);
    assert.equal(sameSubjectReplay.reviewerTrusted, true);
    assert.equal(sameSubjectReplay.principalsDistinct, false);
    assert.equal(sameSubjectReplay.valid, false);

    for (const invented of ["invented-source-a", "invented-source-b", "invented-source-c"]) {
      const inventedCase = { ...corpusCase, sourceId: invented };
      const changed = structuredClone(provenance);
      changed.caseDigest = sha256Canonical(parseAgenticCorpusCase(inventedCase));
      changed.source.sourceId = invented;
      const signed = sealProvenance(changed, trust);
      assert.equal(
        replayAgenticCorpusProvenance(
          inventedCase,
          signed,
          trust.policy,
          trust.expectedPolicyDigest,
        ).sourceRegistered,
        false,
      );
    }
  });

  it("rejects source aliases that reuse a source identity digest", async () => {
    const { root, trust } = await readyCorpus(true);
    await assert.rejects(() => inspectAgenticCorpus(root, trust), /PROVENANCE_POLICY_INVALID/);
  });

  it("fails closed for invented sources and missing, malformed, or noncanonical sidecars", async () => {
    const root = await corpusRoot();
    const trust = trustFixture();
    const corpusCase = caseFixture(0, "invented-source-a");
    await writeCase(root, "public", corpusCase);
    await writeSignedCase(root, "private", caseFixture(19), trust);
    await assert.rejects(() => inspectAgenticCorpus(root, trust), /PROVENANCE_MISSING_OR_INVALID/);

    const validCase = caseFixture();
    const provenance = provenanceFor(validCase, trust);
    await writeCase(root, "public", validCase);
    await writeFile(
      path.join(root, "public", `${validCase.caseId}.provenance.json`),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    await assert.rejects(() => inspectAgenticCorpus(root, trust), /PROVENANCE_JSON_NONCANONICAL/);

    const duplicateText = `${canonicalize(provenance).replace(
      '"schemaVersion":"1.0.0"',
      '"schemaVersion":"1.0.0","schemaVersion":"1.0.0"',
    )}\n`;
    await writeFile(
      path.join(root, "public", `${validCase.caseId}.provenance.json`),
      duplicateText,
    );
    await assert.rejects(() => inspectAgenticCorpus(root, trust), /PROVENANCE_JSON_NONCANONICAL/);
  });

  it("reports public split invalidity before private split invalidity deterministically", async () => {
    const root = await corpusRoot();
    const trust = trustFixture();
    await writeFile(path.join(root, "public", "public-broken.case.json"), "{broken\n");
    await writeCase(root, "private", caseFixture(19));

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await assert.rejects(() => inspectAgenticCorpus(root, trust), /CASE_JSON_INVALID/);
    }
  });

  it("replays provenance through the read-only CLI command", async () => {
    const { root, trust } = await readyCorpus();
    const result = await invokeCli([
      "replay-provenance",
      path.join(root, "public", "case-0.case.json"),
      path.join(root, "public", "case-0.provenance.json"),
      ...(await trustCliArgs(root, trust)),
    ]);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).valid, true);
  });

  it("does not leak holdout identifiers when signed provenance is invalid", async () => {
    const { root, trust } = await readyCorpus();
    const sidecarPath = path.join(root, "private", "case-19.provenance.json");
    const parsed = JSON.parse(await readFile(sidecarPath, "utf8"));
    await writeFile(sidecarPath, `${JSON.stringify(parsed, null, 2)}\n`);
    const result = await evaluateAgenticCorpusHoldout(root, trust);
    assert.deepEqual(result, {
      schemaVersion: "1.0.0",
      status: "INVALID_CORPUS",
      reasonCodes: ["CORPUS_INVALID"],
    });
    assert.doesNotMatch(JSON.stringify(result), /case-19|source-|subject|key|count/i);
  });

  it("rejects invalid keys, signatures, execution state, and empty evidence", () => {
    const trust = trustFixture();
    const corpusCase = caseFixture();
    const provenance = provenanceFor(corpusCase, trust);
    const variants: unknown[] = [
      { ...provenance, author: { ...provenance.author, signature: "bad" } },
      { ...provenance, author: { ...provenance.author, keyId: digest("1") } },
      { ...provenance, execution: { ...provenance.execution, status: "PENDING" } },
      { ...provenance, execution: { ...provenance.execution, evidenceDigests: [] } },
    ];
    const badKeyPolicy = structuredClone(trust.policy);
    const badKey = badKeyPolicy.keys[0];
    assert.ok(badKey);
    badKey.publicKey.data = "bad";
    assert.equal(
      replayAgenticCorpusProvenance(
        corpusCase,
        provenance,
        badKeyPolicy,
        trust.expectedPolicyDigest,
      ).authorTrusted,
      false,
    );
    for (const variant of variants) {
      assert.equal(
        replayAgenticCorpusProvenance(corpusCase, variant, trust.policy, trust.expectedPolicyDigest)
          .valid,
        false,
      );
    }
  });

  it("rejects duplicate key IDs before invalid duplicate key material can shadow trust", () => {
    const trust = trustFixture();
    const corpusCase = caseFixture();
    const provenance = provenanceFor(corpusCase, trust);
    const duplicate = structuredClone(trust.policy);
    const first = duplicate.keys[0];
    assert.ok(first);
    duplicate.keys.push({
      ...first,
      subjectId: "rotated-subject",
      roles: ["REVIEWER"],
      publicKey: { ...first.publicKey, data: "invalid-spki" },
    });

    assert.throws(
      () => parseAgenticCorpusTrustPolicy(duplicate),
      /AGENTIC_CORPUS_TRUST_POLICY_INVALID/,
    );

    const replay = replayAgenticCorpusProvenance(
      corpusCase,
      provenance,
      duplicate,
      trust.expectedPolicyDigest,
    );
    assert.equal(replay.schemaValid, false);
    assert.equal(replay.valid, false);
  });

  it("rejects one Ed25519 key represented by canonical and suffixed SPKI bytes", () => {
    const trust = trustFixture();
    const corpusCase = caseFixture();
    const canonical = trust.policy.keys[0];
    assert.ok(canonical);
    const canonicalDer = Buffer.from(canonical.publicKey.data, "base64url");
    const suffixedDer = Buffer.concat([canonicalDer, Buffer.from([0])]);
    const suffixed = {
      ...canonical,
      keyId: `sha256:${createHash("sha256").update(suffixedDer).digest("hex")}`,
      subjectId: "suffix-reviewer",
      roles: ["REVIEWER" as const],
      publicKey: { ...canonical.publicKey, data: suffixedDer.toString("base64url") },
    };
    const unsignedPolicy = {
      schemaVersion: "1.0.0" as const,
      policyId: "spki-suffix-hostile",
      keys: [{ ...canonical, roles: ["AUTHOR" as const] }, suffixed],
      sources: [
        {
          sourceId: corpusCase.sourceId,
          sourceIdentityDigest: digest("4"),
          authorizedAuthorSubjectIds: [canonical.subjectId],
          authorizedReviewerSubjectIds: [suffixed.subjectId],
        },
      ],
    };
    const policy = {
      ...unsignedPolicy,
      policyDigest: agenticCorpusTrustPolicyDigest(unsignedPolicy),
    };
    const base = provenanceFor(corpusCase, trust);
    const unsigned = {
      ...base,
      trustPolicyDigest: policy.policyDigest,
      reviewer: { keyId: suffixed.keyId, signature: "pending" },
      provenanceDigest: undefined,
    };
    const bytes = agenticCorpusProvenanceSigningBytes(unsigned);
    const signed = {
      ...unsigned,
      author: {
        ...unsigned.author,
        signature: sign(null, bytes, trust.author.privateKey).toString("base64url"),
      },
      reviewer: {
        ...unsigned.reviewer,
        signature: sign(null, bytes, trust.author.privateKey).toString("base64url"),
      },
    };
    const provenance = {
      ...signed,
      provenanceDigest: agenticCorpusProvenanceDigest(signed),
    };

    assert.equal(
      replayAgenticCorpusProvenance(corpusCase, provenance, policy, policy.policyDigest).valid,
      false,
    );
  });

  it("rejects sidecar symlinks that escape the physical split", async (context) => {
    const root = await corpusRoot();
    const trust = trustFixture();
    const corpusCase = caseFixture();
    await writeCase(root, "public", corpusCase);
    await writeSignedCase(root, "private", caseFixture(19), trust);
    const external = path.join(root, "external-provenance.json");
    await writeFile(external, `${canonicalize(provenanceFor(corpusCase, trust))}\n`);
    const link = path.join(root, "public", `${corpusCase.caseId}.provenance.json`);
    try {
      await symlink(external, link, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("Windows symlink privilege is unavailable");
        return;
      }
      throw error;
    }
    await assert.rejects(() => inspectAgenticCorpus(root, trust), /PROVENANCE_FILE_INVALID/);
  });

  it("rejects NFC and case-folded case identifier collisions across splits", async () => {
    const root = await corpusRoot();
    const trust = trustFixture();
    await writeSignedCase(root, "public", { ...caseFixture(1), caseId: "Case-1" }, trust);
    await writeSignedCase(root, "private", { ...caseFixture(1), caseId: "case-1" }, trust);

    await assert.rejects(() => inspectAgenticCorpus(root, trust), /PORTABLE_CASE_ID_COLLISION/);
  });

  it("never treats an unsigned legacy corpus as READY", async () => {
    const { root } = await readyCorpus();

    const status = await inspectAgenticCorpus(root);

    assert.equal(status.status, "NOT_READY");
    assert.deepEqual(status.failedGates, ["PROVENANCE_POLICY_REQUIRED"]);
  });
});
