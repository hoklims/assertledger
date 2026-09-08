import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVerificationRequest } from "../../src/contracts/index.js";
import {
  CAMPAIGN_SCHEMA_VERSION,
  NEUTRAL_REWRITE,
  replaceExactlyOnce,
  sha256Bytes,
  TARGET_MUTATIONS,
} from "./campaign.js";
import {
  buildExistingTestCandidates,
  EXISTING_TESTS_CAMPAIGN_ID,
  EXISTING_TESTS_CANDIDATE_ROOT,
  EXISTING_TESTS_SNAPSHOT_COUNT,
  EXISTING_TESTS_SOURCE_PATH,
  extractExistingCoreTests,
} from "./existing-tests.js";

interface ExistingTestsOperatorPlan {
  schemaVersion: "1.0.0";
  campaignId: typeof EXISTING_TESTS_CAMPAIGN_ID;
  repositoryRoot: string;
  sourceTestCount: typeof EXISTING_TESTS_SNAPSHOT_COUNT;
  targetIds: string[];
  requiredAttempts: 2;
  minimumTargetWeightPermille: 250;
  maximumSelectedCandidates: typeof EXISTING_TESTS_SNAPSHOT_COUNT;
}

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (typeof item !== "object" || item === null) return item;
    return Object.fromEntries(
      Object.entries(item)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sort(entry)]),
    );
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function parseOperatorPlan(value: unknown): ExistingTestsOperatorPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("INVALID_EXISTING_TESTS_OPERATOR_PLAN");
  }
  const plan = value as Record<string, unknown>;
  const expected = [
    "campaignId",
    "maximumSelectedCandidates",
    "minimumTargetWeightPermille",
    "repositoryRoot",
    "requiredAttempts",
    "schemaVersion",
    "sourceTestCount",
    "targetIds",
  ].sort();
  if (
    Object.keys(plan).sort().join("\0") !== expected.join("\0") ||
    plan.schemaVersion !== CAMPAIGN_SCHEMA_VERSION ||
    plan.campaignId !== EXISTING_TESTS_CAMPAIGN_ID ||
    typeof plan.repositoryRoot !== "string" ||
    plan.repositoryRoot.length === 0 ||
    plan.sourceTestCount !== EXISTING_TESTS_SNAPSHOT_COUNT ||
    plan.requiredAttempts !== 2 ||
    plan.minimumTargetWeightPermille !== 250 ||
    plan.maximumSelectedCandidates !== EXISTING_TESTS_SNAPSHOT_COUNT ||
    !Array.isArray(plan.targetIds) ||
    plan.targetIds.join("\0") !== TARGET_MUTATIONS.map(({ id }) => id).join("\0")
  ) {
    throw new Error("INVALID_EXISTING_TESTS_OPERATOR_PLAN");
  }
  return plan as unknown as ExistingTestsOperatorPlan;
}

export async function buildExistingCoreTestsCampaign(options: {
  operatorPlanPath: string;
  expectedOperatorPlanDigest: string;
  outputDirectory: string;
}): Promise<{ request: ReturnType<typeof parseVerificationRequest>; files: string[] }> {
  const planBytes = await readFile(options.operatorPlanPath);
  if (sha256Bytes(planBytes) !== options.expectedOperatorPlanDigest) {
    throw new Error("OPERATOR_PLAN_DIGEST_MISMATCH");
  }
  const plan = parseOperatorPlan(JSON.parse(planBytes.toString("utf8")) as unknown);
  const repositoryRoot = path.resolve(plan.repositoryRoot);
  const dependencyRoot = await realpath(path.join(repositoryRoot, "node_modules"));
  if (!(await stat(dependencyRoot)).isDirectory()) throw new Error("DEPENDENCY_ROOT_NOT_DIRECTORY");
  const coreSource = await readFile(path.join(repositoryRoot, "src/core/index.ts"), "utf8");
  const testSourcePath = path.join(repositoryRoot, EXISTING_TESTS_SOURCE_PATH);
  const testSource = await readFile(testSourcePath, "utf8");
  const extracted = buildExistingTestCandidates(
    testSource,
    extractExistingCoreTests(testSourcePath),
  );
  if (extracted.catalogue.length !== plan.sourceTestCount) {
    throw new Error(
      `CORE_TEST_COUNT_DRIFT:expected=${plan.sourceTestCount}:actual=${extracted.catalogue.length}`,
    );
  }
  const corePath = "src/core/index.ts";
  const worlds = [
    {
      id: "reference",
      kind: "REFERENCE" as const,
      required: true,
      weight: 0,
      provenance: `${EXISTING_TESTS_CAMPAIGN_ID}:reference`,
      files: [],
    },
    {
      id: NEUTRAL_REWRITE.id,
      kind: "NEUTRAL" as const,
      required: true,
      weight: 0,
      provenance: `${EXISTING_TESTS_CAMPAIGN_ID}:${NEUTRAL_REWRITE.id}`,
      files: [{ path: corePath, content: replaceExactlyOnce(coreSource, NEUTRAL_REWRITE) }],
    },
    ...TARGET_MUTATIONS.map((target) => ({
      id: target.id,
      kind: "TARGET" as const,
      required: true,
      weight: 250,
      provenance: `${EXISTING_TESTS_CAMPAIGN_ID}:${target.id}`,
      files: [{ path: corePath, content: replaceExactlyOnce(coreSource, target) }],
    })),
  ];
  const candidates = extracted.candidates.map((candidate) => ({
    id: candidate.id,
    files: candidate.files.map((file) => ({
      path: `${EXISTING_TESTS_CANDIDATE_ROOT}/${candidate.id}/${file.name}`,
      content: file.content,
    })),
  }));
  const maximumExecutions = (1 + candidates.length) * worlds.length * plan.requiredAttempts;
  const request = parseVerificationRequest({
    schemaVersion: "1.0.0",
    repository: {
      root: repositoryRoot,
      exclude: ["node_modules", ".git", "graphify-out", "RESULT-existing-tests-v1.md"],
    },
    adapter: {
      kind: "testforge-command",
      executable: process.execPath,
      arguments: ["benchmarks/self-hosted-core/adapter.mjs", dependencyRoot],
      protocolVersion: "1.0.0",
    },
    isolation: {
      kind: "trusted-local",
      acknowledgedUnsafeExecution: true,
      environmentAllowlist: ["PATH", "SystemRoot", "TEMP", "TMP"],
    },
    candidateRoots: [EXISTING_TESTS_CANDIDATE_ROOT],
    budgets: {
      maximumCandidates: candidates.length,
      maximumWorlds: worlds.length,
      maximumExecutions,
      maximumRepositoryFiles: 10_000,
      maximumRepositoryBytes: 100_000_000,
      maximumWorldOverlayBytes: 10_000_000,
      maximumCandidateBytes: 1_000_000,
      maximumTotalCandidateBytes: 5_000_000,
      timeoutMsPerExecution: 30_000,
      maximumOutputBytes: 1_000_000,
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: plan.requiredAttempts,
      minimumTargetWeightPermille: plan.minimumTargetWeightPermille,
      maximumSelectedCandidates: plan.maximumSelectedCandidates,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds,
    candidates,
  });

  const artifacts = new Map<string, string>();
  artifacts.set("operator-plan.json", planBytes.toString("utf8"));
  artifacts.set("request.json", stableJson(request));
  artifacts.set("worlds.json", stableJson(worlds));
  artifacts.set("candidates.json", stableJson(candidates));
  artifacts.set("existing-test-catalogue.json", stableJson(extracted.catalogue));
  artifacts.set(
    "mutation-definitions.json",
    stableJson({ neutral: NEUTRAL_REWRITE, targets: TARGET_MUTATIONS }),
  );
  await mkdir(options.outputDirectory, { recursive: true });
  const files = [...artifacts.keys()].sort();
  for (const file of files) {
    await writeFile(
      path.join(options.outputDirectory, file),
      artifacts.get(file) as string,
      "utf8",
    );
  }
  return { request, files };
}

async function main(): Promise<void> {
  const [operatorPlanPath, expectedOperatorPlanDigest, outputDirectory] = process.argv.slice(2);
  if (!operatorPlanPath || !expectedOperatorPlanDigest || !outputDirectory) {
    throw new Error(
      "usage: existing-tests-builder.ts OPERATOR_PLAN EXPECTED_SHA256 OUTPUT_DIRECTORY",
    );
  }
  await buildExistingCoreTestsCampaign({
    operatorPlanPath,
    expectedOperatorPlanDigest,
    outputDirectory,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
