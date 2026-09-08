import { createHash } from "node:crypto";

export const CAMPAIGN_SCHEMA_VERSION = "1.0.0" as const;
export const CAMPAIGN_ID = "assertledger-self-hosted-core-v1" as const;
export const CANDIDATE_ROOT = "benchmarks/self-hosted-core/generated-candidates" as const;

export interface MutationDefinition {
  id: string;
  description: string;
  anchor: string;
  replacement: string;
}

export const TARGET_MUTATIONS: readonly MutationDefinition[] = [
  {
    id: "target-dependent-gate-order",
    description: "Permute les gates dependantes NEUTRAL et TARGET_STRENGTH.",
    anchor: 'gates.push(notRun("REFERENCE"), notRun("NEUTRAL"), notRun("TARGET_STRENGTH"));',
    replacement: 'gates.push(notRun("REFERENCE"), notRun("TARGET_STRENGTH"), notRun("NEUTRAL"));',
  },
  {
    id: "target-threshold-strict-greater",
    description: "Remplace la borne inclusive du seuil de poids par une borne stricte.",
    anchor: "targetWeightKilled * 1_000 >= totalWeight * input.policy.minimumTargetWeightPermille;",
    replacement:
      "targetWeightKilled * 1_000 > totalWeight * input.policy.minimumTargetWeightPermille;",
  },
  {
    id: "target-stability-completeness-only",
    description: "Accepte des tentatives completes meme lorsque leurs outcomes se contredisent.",
    anchor:
      "if (!isComplete(runs, requiredAttempts)) return false;\n  return runs.every((run) => run.outcome === runs[0]?.outcome);",
    replacement: "if (!isComplete(runs, requiredAttempts)) return false;\n  return true;",
  },
  {
    id: "target-duration-in-decision-digest",
    description: "Inclut la duree volatile dans le digest de decision.",
    anchor: "durationMs: _durationMs,",
    replacement: "",
  },
] as const;

export const NEUTRAL_REWRITE: MutationDefinition = {
  id: "neutral-comparator-rewrite",
  description: "Reecrit la collecte des runs NEUTRAL sans changer son comportement.",
  anchor: `const neutralRuns = worldRuns
    .filter(({ world }) => world.kind === "NEUTRAL")
    .flatMap(({ runs }) => runs);`,
  replacement: `const neutralRuns = worldRuns.flatMap(({ world, runs }) =>
    world.kind === "NEUTRAL" ? runs : [],
  );`,
};

const COMMON_FIXTURE = `
function digest(label) {
  return core.sha256Canonical({ fixture: label });
}

function observation(candidateId, worldId, attempt, outcome, discovered = candidateId === null ? 0 : 1, attributed = candidateId !== null) {
  return {
    runId: \`\${candidateId ?? "control"}:\${worldId}:\${attempt}\`,
    candidateId,
    worldId,
    attempt,
    outcome,
    testsDiscovered: candidateId === null ? 1 : 2,
    candidateTestsDiscovered: discovered,
    attributed,
    durationMs: 10 + attempt,
    exitCode: outcome === "PASS" ? 0 : 1,
    stdoutDigest: digest(\`stdout:\${candidateId ?? "control"}:\${worldId}:\${attempt}\`),
    stderrDigest: digest(\`stderr:\${candidateId ?? "control"}:\${worldId}:\${attempt}\`),
  };
}

function campaign() {
  const worlds = [
    { id: "reference", kind: "REFERENCE", required: true, weight: 0 },
    { id: "target-a", kind: "TARGET", required: true, weight: 1 },
    { id: "target-b", kind: "TARGET", required: false, weight: 1 },
    { id: "neutral", kind: "NEUTRAL", required: true, weight: 0 },
  ];
  const observations = worlds.flatMap((world) => [
    observation(null, world.id, 1, "PASS"),
    observation(null, world.id, 2, "PASS"),
    observation("candidate", world.id, 1, world.kind === "TARGET" ? "ASSERTION_FAILURE" : "PASS"),
    observation("candidate", world.id, 2, world.kind === "TARGET" ? "ASSERTION_FAILURE" : "PASS"),
  ]);
  return {
    schemaVersion: "1.0.0",
    repositoryDigest: digest("repository"),
    evidenceContext: {
      engine: { name: "testforge", version: "0.1.0" },
      adapter: { name: "node-test", version: process.versions.node, configuration: {} },
      execution: {
        isolation: "UNSANDBOXED",
        environmentAllowlist: [],
        budgets: { timeoutMsPerExecution: 1000, maximumOutputBytes: 65536 },
        candidateRoots: ["tests/candidates"],
      },
      worlds: worlds.map((world) => ({
        id: world.id,
        provenance: \`fixture:\${world.id}\`,
        digest: digest(\`world:\${world.id}\`),
      })),
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 2,
      minimumTargetWeightPermille: 1000,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds,
    candidates: [{ id: "candidate", digest: digest("candidate"), sizeBytes: 100 }],
    observations,
  };
}
`;

function candidateSource(name: string, body: string): string {
  return `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport * as core from "../../../../src/core/index.js";\n${COMMON_FIXTURE}\ntest(${JSON.stringify(name)}, () => {\n${body}\n});\n`;
}

export const TEST_SLICES = {
  gateOrder: candidateSource(
    "dependent gates retain their public order",
    `  const input = campaign();
  for (const run of input.observations) {
    if (run.candidateId === "candidate") run.candidateTestsDiscovered = 0;
  }
  const manifest = core.decideEvidence(input);
  assert.deepEqual(manifest.candidates[0].gates.map((gate) => gate.name), [
    "COMPLETENESS", "STABILITY", "DISCOVERY", "REFERENCE", "NEUTRAL", "TARGET_STRENGTH",
  ]);`,
  ),
  thresholdBoundary: candidateSource(
    "the exact target threshold is inclusive",
    `  const input = campaign();
  input.policy.minimumTargetWeightPermille = 500;
  for (const run of input.observations) {
    if (run.candidateId === "candidate" && run.worldId === "target-b") run.outcome = "PASS";
  }
  const manifest = core.decideEvidence(input);
  assert.equal(manifest.decision.status, "VERIFIED");`,
  ),
  contradictoryStability: candidateSource(
    "contradictory attempts are unstable",
    `  const input = campaign();
  const contradictory = input.observations.find((run) =>
    run.candidateId === "candidate" && run.worldId === "reference" && run.attempt === 2,
  );
  assert.ok(contradictory);
  contradictory.outcome = "ASSERTION_FAILURE";
  const manifest = core.decideEvidence(input);
  assert.equal(manifest.decision.status, "INCONCLUSIVE");
  assert.equal(manifest.candidates[0].status, "UNSTABLE");`,
  ),
  durationExclusion: candidateSource(
    "duration is excluded from the decision digest",
    `  const manifest = core.decideEvidence(campaign());
  manifest.observations[0].durationMs += 1;
  assert.equal(core.verifyDecisionDigest(manifest).valid, true);`,
  ),
} as const;

export interface CandidateDefinition {
  id: string;
  files: readonly { name: string; content: string }[];
}

export const CANDIDATE_DEFINITIONS: readonly CandidateDefinition[] = [
  { id: "gate-order", files: [{ name: "gate-order.test.ts", content: TEST_SLICES.gateOrder }] },
  {
    id: "threshold-boundary",
    files: [{ name: "threshold-boundary.test.ts", content: TEST_SLICES.thresholdBoundary }],
  },
  {
    id: "contradictory-stability",
    files: [
      { name: "contradictory-stability.test.ts", content: TEST_SLICES.contradictoryStability },
    ],
  },
  {
    id: "duration-exclusion",
    files: [{ name: "duration-exclusion.test.ts", content: TEST_SLICES.durationExclusion }],
  },
  {
    id: "core-contract-complete",
    files: [
      { name: "gate-order.test.ts", content: TEST_SLICES.gateOrder },
      { name: "threshold-boundary.test.ts", content: TEST_SLICES.thresholdBoundary },
      { name: "contradictory-stability.test.ts", content: TEST_SLICES.contradictoryStability },
      { name: "duration-exclusion.test.ts", content: TEST_SLICES.durationExclusion },
    ],
  },
  {
    id: "weak-canonicalization",
    files: [
      {
        name: "weak-canonicalization.test.ts",
        content: candidateSource(
          "canonicalization ignores object insertion order",
          `  assert.equal(core.canonicalize({ b: 2, a: 1 }), core.canonicalize({ a: 1, b: 2 }));`,
        ),
      },
    ],
  },
  {
    id: "weak-safe-path",
    files: [
      {
        name: "weak-safe-path.test.ts",
        content: candidateSource(
          "safe relative paths are normalized",
          `  assert.equal(core.assertSafeRelativePath("tests/example.test.ts", ["tests"]), "tests/example.test.ts");`,
        ),
      },
    ],
  },
] as const;

export function sha256Bytes(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function replaceExactlyOnce(source: string, definition: MutationDefinition): string {
  const first = source.indexOf(definition.anchor);
  if (first < 0 || source.indexOf(definition.anchor, first + definition.anchor.length) >= 0) {
    throw new Error(`MUTATION_ANCHOR_NOT_UNIQUE:${definition.id}`);
  }
  return `${source.slice(0, first)}${definition.replacement}${source.slice(first + definition.anchor.length)}`;
}
