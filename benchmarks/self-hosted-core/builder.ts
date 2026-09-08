import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVerificationRequest } from "../../src/contracts/index.js";
import {
  CAMPAIGN_ID,
  CAMPAIGN_SCHEMA_VERSION,
  CANDIDATE_DEFINITIONS,
  CANDIDATE_ROOT,
  NEUTRAL_REWRITE,
  replaceExactlyOnce,
  sha256Bytes,
  TARGET_MUTATIONS,
} from "./campaign.js";

interface OperatorPlan {
  schemaVersion: "1.0.0";
  campaignId: typeof CAMPAIGN_ID;
  repositoryRoot: string;
  targetIds: string[];
  requiredAttempts: 2;
  minimumTargetWeightPermille: 1000;
  maximumSelectedCandidates: 4;
}

function parseOperatorPlan(value: unknown): OperatorPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("INVALID_OPERATOR_PLAN");
  }
  const plan = value as Record<string, unknown>;
  const keys = Object.keys(plan).sort();
  const expected = [
    "campaignId",
    "maximumSelectedCandidates",
    "minimumTargetWeightPermille",
    "repositoryRoot",
    "requiredAttempts",
    "schemaVersion",
    "targetIds",
  ].sort();
  const targets = TARGET_MUTATIONS.map(({ id }) => id);
  if (
    keys.join("\0") !== expected.join("\0") ||
    plan.schemaVersion !== CAMPAIGN_SCHEMA_VERSION ||
    plan.campaignId !== CAMPAIGN_ID ||
    typeof plan.repositoryRoot !== "string" ||
    plan.repositoryRoot.length === 0 ||
    plan.requiredAttempts !== 2 ||
    plan.minimumTargetWeightPermille !== 1000 ||
    plan.maximumSelectedCandidates !== 4 ||
    !Array.isArray(plan.targetIds) ||
    plan.targetIds.join("\0") !== targets.join("\0")
  ) {
    throw new Error("INVALID_OPERATOR_PLAN");
  }
  return plan as unknown as OperatorPlan;
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

export async function buildSelfHostedCampaign(options: {
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
  const corePath = "src/core/index.ts";
  const worlds = [
    {
      id: "reference",
      kind: "REFERENCE" as const,
      required: true,
      weight: 0,
      provenance: `${CAMPAIGN_ID}:reference`,
      files: [],
    },
    {
      id: NEUTRAL_REWRITE.id,
      kind: "NEUTRAL" as const,
      required: true,
      weight: 0,
      provenance: `${CAMPAIGN_ID}:${NEUTRAL_REWRITE.id}`,
      files: [{ path: corePath, content: replaceExactlyOnce(coreSource, NEUTRAL_REWRITE) }],
    },
    ...TARGET_MUTATIONS.map((target) => ({
      id: target.id,
      kind: "TARGET" as const,
      required: true,
      weight: 250,
      provenance: `${CAMPAIGN_ID}:${target.id}`,
      files: [{ path: corePath, content: replaceExactlyOnce(coreSource, target) }],
    })),
  ];
  const candidates = CANDIDATE_DEFINITIONS.map((candidate) => ({
    id: candidate.id,
    files: candidate.files.map((file) => ({
      path: `${CANDIDATE_ROOT}/${candidate.id}/${file.name}`,
      content: file.content,
    })),
  }));
  const maximumExecutions = (1 + candidates.length) * worlds.length * plan.requiredAttempts;
  const request = parseVerificationRequest({
    schemaVersion: "1.0.0",
    repository: {
      root: repositoryRoot,
      exclude: ["node_modules", ".git", "graphify-out"],
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
    candidateRoots: [CANDIDATE_ROOT],
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
    throw new Error("usage: builder.ts OPERATOR_PLAN EXPECTED_SHA256 OUTPUT_DIRECTORY");
  }
  await buildSelfHostedCampaign({ operatorPlanPath, expectedOperatorPlanDigest, outputDirectory });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
