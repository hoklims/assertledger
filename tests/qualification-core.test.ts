import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalize, sha256Canonical } from "../src/core/index.js";
import type {
  QualificationPlan,
  QualificationObservation,
  QualificationReceipt,
} from "../src/contracts/qualification.js";

const corePath = "../src/core/qualification.js";
const contractsPath = "../src/contracts/qualification.js";
const core = await import(corePath).catch(() => ({}));
const contracts = await import(contractsPath).catch(() => ({}));

function present<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}

test("qualification exposes deterministic scope-bound decisions and strict plan parsing", () => {
  assert.equal(typeof core.createQualificationReceipt, "function");
  assert.equal(typeof core.replayQualificationReceipt, "function");
  assert.equal(typeof contracts.parseQualificationPlan, "function");
});

function fixture(): QualificationPlan {
  const digest = sha256Canonical("fixture");
  return {
    schemaVersion: "1.0.0",
    profileId: "suite-local-v1",
    subject: {
      commit: "commit-a",
      baseCommit: "base-a",
      candidateDigest: digest,
      inputDigest: digest,
    },
    tools: [{ id: "node", version: "22.15.0", digest }],
    suites: [{ id: "tests", files: ["tests/sample.test.js"], extraction: "COMPLETE" }],
    obligations: [
      {
        id: "propagation",
        kind: "propagation",
        required: true,
        suiteIds: ["tests"],
        checks: [{ id: "exit", actionId: "gate", field: "exitCode", expected: 1 }],
        limits: [],
      },
    ],
    actions: [
      {
        id: "gate",
        adapter: "command",
        executable: "node",
        arguments: ["gate.js"],
        environment: {},
        prepareFiles: [],
        removePaths: [],
        observe: { trace: true, outputs: [], report: null },
      },
    ],
    worlds: [
      { id: "reference", kind: "REFERENCE", files: [], discriminants: [] },
      {
        id: "fault",
        kind: "TARGET",
        files: [{ path: "gate.js", content: "process.exit(0);" }],
        discriminants: [{ obligationId: "propagation", checkIds: ["exit"] }],
      },
      { id: "neutral", kind: "NEUTRAL", files: [], discriminants: [] },
    ],
    requiredAttempts: 2,
    timeoutMs: 1000,
    maximumOutputBytes: 65536,
    isolation: { kind: "trusted-local", acknowledgedUnsafeExecution: true },
    allowedCandidatePaths: ["candidate.test.js"],
  };
}

function observations(plan: QualificationPlan): QualificationObservation[] {
  const { planDigest } = core.sealQualificationPlan(plan);
  return plan.worlds.flatMap((world) =>
    Array.from({ length: plan.requiredAttempts }, (_, index) =>
      plan.actions.map((action) => ({
        worldId: world.id,
        attempt: index + 1,
        actionId: action.id,
        state: "COMPLETED" as const,
        facts: {
          exitCode: world.kind === "TARGET" ? 0 : 1,
          testsDiscovered: 1,
          attributed: true,
          testOutcome: world.kind === "TARGET" ? "PASS" : "ASSERTION_FAILURE",
        },
        bindingDigest: core.qualificationBinding(
          planDigest,
          plan.subject.candidateDigest,
          world.id,
          index + 1,
          action.id,
        ),
      })),
    ).flat(),
  );
}

function receipt(plan = fixture(), records = observations(plan)): QualificationReceipt {
  return core.createQualificationReceipt({
    ...core.sealQualificationPlan(plan),
    candidateDigest: plan.subject.candidateDigest,
    observations: records,
    provenance: {
      engineVersion: "1.0.0",
      adapterVersions: { command: "1.0.0", "node-test": "1.0.0" },
      runtime: { node: "22.15.0" },
      executionTrust: "TRUSTED_LOCAL_UNSANDBOXED",
    },
    externalCi: null,
  });
}

function reseal(value: QualificationReceipt): QualificationReceipt {
  const {
    planDigest,
    candidateDigest,
    assessments,
    coveredGuaranteeIds,
    openGuaranteeIds,
    decision,
  } = value;
  value.decisionDigest = sha256Canonical({
    planDigest,
    candidateDigest,
    assessments,
    coveredGuaranteeIds,
    openGuaranteeIds,
    decision,
  });
  const { artifactDigest: _discarded, ...artifact } = value;
  value.artifactDigest = sha256Canonical(artifact);
  return value;
}

test("expected nonzero reference and neutral results qualify a propagated-failure contract", () => {
  const result = receipt();
  assert.equal(result.decision, "QUALIFIED");
  assert.deepEqual(result.coveredGuaranteeIds, ["propagation"]);
  assert.deepEqual(core.replayQualificationReceipt(result), {
    valid: true,
    integrityValid: true,
    semanticsValid: true,
    domainValid: true,
    reexecuted: false,
    producerAuthenticated: false,
  });
});

for (const state of ["TIMEOUT", "CRASH", "INFRA_ERROR", "COLLECTION_ERROR", "NO_TESTS"] as const) {
  test(`a target ${state} never receives correct detection credit`, () => {
    const plan = fixture();
    const records = observations(plan);
    for (const record of records) if (record.worldId === "fault") record.state = state;
    const result = receipt(plan, records);
    assert.equal(result.decision, "OPEN");
    assert.deepEqual(result.coveredGuaranteeIds, []);
  });
}

test("incomplete extraction and omitted suites remain named open obligations", () => {
  for (const extraction of ["UNAVAILABLE", "OMITTED"] as const) {
    const plan = fixture();
    present(plan.suites[0]).extraction = extraction;
    present(plan.obligations[0]).suiteIds = ["tests"];
    const result = receipt(plan);
    assert.equal(result.decision, "OPEN");
    assert.ok(present(result.assessments[0]).reasons.includes("SUITE_NOT_EXTRACTED:tests"));
  }
});

test("missing discriminants and unobserved fields cannot qualify", () => {
  const plan = fixture();
  present(plan.worlds[1]).discriminants = [];
  assert.equal(receipt(plan).decision, "OPEN");
  const second = fixture();
  const records = observations(second);
  for (const record of records) if (record.worldId === "fault") delete record.facts.exitCode;
  assert.equal(receipt(second, records).decision, "OPEN");
});

test("unrelated mismatch cannot count as the declared target witness", () => {
  const plan = fixture();
  present(plan.obligations[0]).checks.push({
    id: "selected",
    actionId: "gate",
    field: "selected",
    expected: ["leaf"],
  });
  const records = observations(plan);
  for (const record of records) {
    record.facts.exitCode = 1;
    record.facts.selected = record.worldId === "fault" ? [] : ["leaf"];
  }
  assert.equal(receipt(plan, records).decision, "OPEN");
});

test("every declared fault must discriminate in every repeat", () => {
  const plan = fixture();
  const records = observations(plan);
  present(
    records.find((record) => record.worldId === "fault" && record.attempt === 2),
  ).facts.exitCode = 1;
  const result = receipt(plan, records);
  assert.equal(result.decision, "OPEN");
  assert.ok(present(result.assessments[0]).reasons.includes("UNSTABLE_OBSERVATIONS:fault"));
});

test("reference or neutral mismatches reject the candidate", () => {
  for (const id of ["reference", "neutral"]) {
    const plan = fixture();
    const records = observations(plan);
    present(records.find((record) => record.worldId === id)).facts.exitCode = 0;
    assert.equal(receipt(plan, records).decision, "REJECTED");
  }
});

test("zero discovered tests cannot be misrepresented as completed target evidence", () => {
  const plan = fixture();
  present(plan.actions[0]).adapter = "node-test";
  present(plan.obligations[0]).kind = "tests";
  present(plan.obligations[0]).suiteIds = ["tests"];
  const records = observations(plan);
  for (const record of records) if (record.worldId === "fault") record.facts.testsDiscovered = 0;
  assert.equal(receipt(plan, records).decision, "OPEN");
});

test("unassigned suites keep the complete inventory open", () => {
  const plan = fixture();
  present(plan.obligations[0]).suiteIds = [];
  const result = receipt(plan);
  assert.equal(result.decision, "OPEN");
  assert.ok(present(result.assessments[0]).reasons.includes("UNASSIGNED_SUITE:tests"));
});

test("contradictory completed test facts reject evidence even with all digests resealed", () => {
  const plan = fixture();
  present(plan.actions[0]).adapter = "node-test";
  const baseline = receipt(plan);
  assert.equal(baseline.decision, "QUALIFIED");
  for (const facts of [
    { exitCode: 1, testOutcome: "PASS" },
    { exitCode: 0, testOutcome: "ASSERTION_FAILURE" },
    { exitCode: 1, testOutcome: "COMPILE_FAILURE" },
  ]) {
    const altered = structuredClone(baseline);
    Object.assign(present(altered.observations[0]).facts, facts);
    const generated = core.createQualificationReceipt(altered);
    assert.equal(generated.decision, "REJECTED");
    assert.equal(core.replayQualificationReceipt(generated).valid, false);
    assert.equal(core.replayQualificationReceipt(reseal(altered)).valid, false);
  }
});

test("completed test assertions require candidate attribution and integral discovery counts", () => {
  const plan = fixture();
  present(plan.actions[0]).adapter = "node-test";
  const baseline = receipt(plan);
  assert.equal(baseline.decision, "QUALIFIED");
  for (const facts of [{ attributed: false }, { testsDiscovered: 1.5 }]) {
    const altered = structuredClone(baseline);
    Object.assign(present(altered.observations[0]).facts, facts);
    const generated = core.createQualificationReceipt(altered);
    assert.equal(generated.decision, "REJECTED");
    assert.equal(core.replayQualificationReceipt(generated).valid, false);
    assert.equal(core.replayQualificationReceipt(reseal(altered)).valid, false);
  }
});

test("live CI requires trusted future admission and self-declared independence grants nothing", () => {
  const plan = fixture();
  present(plan.obligations[0]).kind = "ci-live";
  const result = receipt(plan);
  result.externalCi = {
    independent: true,
    authenticated: true,
    commit: "commit-a",
    result: "passed",
  };
  const replay = core.replayQualificationReceipt(reseal(result));
  assert.equal(result.decision, "OPEN");
  assert.equal(replay.valid, true);
});

test("missing duplicate unexpected and rebound reports invalidate replay", () => {
  const base = receipt();
  for (const mutate of [
    (value: QualificationReceipt) => {
      value.observations.pop();
    },
    (value: QualificationReceipt) => {
      value.observations.push(structuredClone(present(value.observations[0])));
    },
    (value: QualificationReceipt) => {
      present(value.observations[0]).worldId = "other";
    },
    (value: QualificationReceipt) => {
      present(value.observations[0]).bindingDigest = sha256Canonical("other");
    },
  ]) {
    const value = structuredClone(base);
    mutate(value);
    assert.equal(core.replayQualificationReceipt(reseal(value)).valid, false);
  }
});

test("altered and rehashed semantic forgeries fail replay independently of artifact integrity", () => {
  const original = receipt();
  const altered = structuredClone(original);
  present(altered.observations[0]).facts.exitCode = 0;
  assert.equal(core.replayQualificationReceipt(altered).integrityValid, false);
  const forged = reseal(altered);
  const replay = core.replayQualificationReceipt(forged);
  assert.equal(replay.integrityValid, true);
  assert.equal(replay.semanticsValid, false);
  assert.equal(replay.valid, false);
});

test("domain mismatch blocks reuse without implying producer authentication", () => {
  const result = receipt();
  const domain = {
    planDigest: result.planDigest,
    candidateDigest: result.candidateDigest,
    inputDigest: result.plan.subject.inputDigest,
    commit: result.plan.subject.commit,
    baseCommit: result.plan.subject.baseCommit,
  };
  assert.equal(core.replayQualificationReceipt(result, domain).valid, true);
  for (const key of Object.keys(domain) as (keyof typeof domain)[]) {
    assert.equal(
      core.replayQualificationReceipt(result, { ...domain, [key]: "changed" }).domainValid,
      false,
    );
  }
});

test("strict plans reject candidate-supplied facts, broken references, duplicate IDs and unsafe paths", () => {
  const cases = [
    (plan: QualificationPlan) => {
      Object.assign(present(plan.actions[0]), { facts: { exitCode: 0 } });
    },
    (plan: QualificationPlan) => {
      present(present(plan.obligations[0]).checks[0]).actionId = "missing";
    },
    (plan: QualificationPlan) => {
      present(present(plan.worlds[1]).discriminants[0]).checkIds = ["missing"];
    },
    (plan: QualificationPlan) => {
      plan.actions.push(structuredClone(present(plan.actions[0])));
    },
    (plan: QualificationPlan) => {
      present(present(plan.worlds[1]).files[0]).path = "../outside";
    },
    (plan: QualificationPlan) => {
      present(plan.actions[0]).environment.NODE_OPTIONS = "--require evil.js";
    },
    (plan: QualificationPlan) => {
      plan.allowedCandidatePaths = ["CON.txt"];
    },
  ];
  for (const mutate of cases) {
    const plan = fixture();
    mutate(plan);
    assert.throws(() => contracts.parseQualificationPlan(plan));
  }
});

test("candidate and sealed plan identity mismatches cannot produce a receipt", () => {
  const result = receipt();
  assert.throws(() =>
    core.createQualificationReceipt({ ...result, candidateDigest: sha256Canonical("other") }),
  );
  assert.throws(() =>
    core.createQualificationReceipt({ ...result, planDigest: sha256Canonical("other") }),
  );
});

test("receipt and replay reject unknown fields and unsupported versions", () => {
  const result = receipt();
  assert.equal(core.replayQualificationReceipt({ ...result, merged: true }).valid, false);
  assert.equal(core.replayQualificationReceipt({ ...result, schemaVersion: "2.0.0" }).valid, false);
  assert.ok(contracts.qualificationPlanJsonSchema());
  assert.ok(contracts.qualificationReceiptJsonSchema());
  assert.ok(contracts.qualificationReplayResultJsonSchema());
});

test("operator plans pin transitive tools with an explicit identity and structured version probe", () => {
  const plan = fixture();
  Object.assign(present(plan.tools[0]), {
    identityPath: "C:/tools/pnpm/pnpm.mjs",
    versionCommand: {
      executable: "C:/tools/node/node.exe",
      arguments: ["C:/tools/pnpm/pnpm.mjs", "--version"],
    },
  });
  present(plan.actions[0]).environment.PATH = "C:/tools/pnpm;C:/tools/node";
  assert.doesNotThrow(() => contracts.parseQualificationPlan(plan));
  const parsed = contracts.parseQualificationPlan(plan);
  assert.equal(present(parsed.tools[0]).identityPath, "C:/tools/pnpm/pnpm.mjs");
  assert.deepEqual(present(parsed.tools[0]).versionCommand.arguments, [
    "C:/tools/pnpm/pnpm.mjs",
    "--version",
  ]);
  assert.equal(present(parsed.actions[0]).environment.PATH, "C:/tools/pnpm;C:/tools/node");
});

test("transitive tool identity requires absolute paths and structured probes remain closed", () => {
  for (const fields of [
    { identityPath: "relative/pnpm.mjs" },
    { versionCommand: { executable: "node", arguments: [], shell: true } },
  ]) {
    const plan = fixture();
    Object.assign(present(plan.tools[0]), fields);
    assert.throws(() => contracts.parseQualificationPlan(plan));
  }
});

test("execution requests and expected replay domains use strict schemas with named JSON schemas", () => {
  assert.equal(typeof contracts.QualificationExecutionRequestSchema?.parse, "function");
  assert.equal(typeof contracts.QualificationExpectedDomainSchema?.parse, "function");
  const plan = fixture();
  const { planDigest } = core.sealQualificationPlan(plan);
  const request = {
    root: "C:/fixture",
    plan,
    planDigest,
    candidate: { files: [{ path: "candidate.test.js", content: "" }] },
  };
  assert.deepEqual(contracts.QualificationExecutionRequestSchema.parse(request), request);
  assert.throws(() =>
    contracts.QualificationExecutionRequestSchema.parse({ ...request, shell: true }),
  );
  const domain = {
    planDigest,
    candidateDigest: plan.subject.candidateDigest,
    inputDigest: plan.subject.inputDigest,
    commit: plan.subject.commit,
    baseCommit: plan.subject.baseCommit,
  };
  assert.deepEqual(contracts.QualificationExpectedDomainSchema.parse(domain), domain);
  assert.throws(() =>
    contracts.QualificationExpectedDomainSchema.parse({ ...domain, unknown: true }),
  );
  for (const getter of [
    contracts.qualificationPlanJsonSchema,
    contracts.qualificationReceiptJsonSchema,
    contracts.qualificationReplayResultJsonSchema,
    contracts.qualificationExecutionRequestJsonSchema,
  ]) {
    const schema = getter();
    assert.equal(typeof schema.$id, "string");
    assert.equal(typeof schema.title, "string");
  }
});

// These signing fixtures qualify admission behavior; they are not observations of Bitbucket.
function signedCiFixture() {
  const keys = generateKeyPairSync("ed25519");
  const plan = fixture();
  present(plan.obligations[0]).kind = "ci-live";
  present(plan.worlds[1]).discriminants = [];
  plan.worlds = plan.worlds.filter((world) => world.kind !== "TARGET");
  Object.assign(plan, {
    ciTrust: {
      repositoryId: "public-fixture/repository",
      observerId: "independent-observer",
      publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      requiredSteps: [
        {
          id: "gate",
          commandDigest: sha256Canonical({ executable: "pnpm", arguments: ["check"] }),
        },
      ],
    },
  });
  const payload = {
    protocolVersion: "1.0.0",
    provider: "bitbucket",
    repositoryId: "public-fixture/repository",
    observerId: "independent-observer",
    ...plan.subject,
    planDigest: sha256Canonical(plan),
    pipelineId: "42",
    pipelineUrl: "https://bitbucket.org/public-fixture/repository/pipelines/results/42",
    steps: [
      {
        id: "gate",
        commandDigest: sha256Canonical({ executable: "pnpm", arguments: ["check"] }),
        commit: plan.subject.commit,
        result: "SUCCESS",
      },
    ],
    terminalResult: "SUCCESS",
  };
  const signer = (statement: typeof payload) => ({
    ...statement,
    signature: sign(
      null,
      Buffer.from(canonicalize({ domain: "ASSERTLEDGER_CI_OBSERVATION_V1", statement })),
      keys.privateKey,
    ).toString("base64"),
  });
  return { plan, payload, signer };
}

test("a trusted signed exact-domain CI observation covers live CI without a local target witness", () => {
  const { plan, payload, signer } = signedCiFixture();
  assert.doesNotThrow(() => contracts.parseQualificationPlan(plan));
  const result = core.createQualificationReceipt({ ...receipt(plan), externalCi: signer(payload) });
  assert.equal(result.decision, "QUALIFIED");
  assert.deepEqual(result.coveredGuaranteeIds, ["propagation"]);
  const replay = core.replayQualificationReceipt(result);
  assert.equal(replay.valid, true);
  assert.equal(replay.producerAuthenticated, false);
  assert.equal(replay.reexecuted, false);
});

test("trusted CI admission rejects invalid signatures and signed wrong domains or incomplete execution", () => {
  const { plan, payload, signer } = signedCiFixture();
  const changes = [
    { commit: "other" },
    { baseCommit: "other" },
    { candidateDigest: sha256Canonical("other") },
    { inputDigest: sha256Canonical("other") },
    { planDigest: sha256Canonical("other") },
    { repositoryId: "other/repository" },
    { observerId: "other" },
    { terminalResult: "FAILURE" },
    { pipelineUrl: "https://example.com/pipelines/results/42" },
    { pipelineUrl: "https://bitbucket.org/public-fixture/repository/pipelines/results/43" },
    { pipelineUrl: "https://bitbucket.org/other/repository/pipelines/results/42" },
    { pipelineUrl: "https://api.bitbucket.org/fake/prefix/public-fixture/repository/pipelines/42" },
    { steps: [] },
    { steps: [...payload.steps, ...payload.steps] },
    { steps: [{ ...present(payload.steps[0]), result: "SKIPPED" }] },
    { steps: [{ ...present(payload.steps[0]), commandDigest: sha256Canonical("other") }] },
    { steps: [{ ...present(payload.steps[0]), commit: "other" }] },
  ];
  for (const change of changes) {
    const result = core.createQualificationReceipt({
      ...receipt(plan),
      externalCi: signer({ ...payload, ...change }),
    });
    assert.equal(result.decision, "OPEN");
    assert.equal(core.replayQualificationReceipt(result).valid, true);
  }
  const signed = signer(payload);
  signed.signature = Buffer.alloc(64).toString("base64");
  assert.equal(
    core.createQualificationReceipt({ ...receipt(plan), externalCi: signed }).decision,
    "OPEN",
  );
});
