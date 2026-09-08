import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { buildSelfHostedCampaign } from "../benchmarks/self-hosted-core/builder.js";
import { buildExistingCoreTestsCampaign } from "../benchmarks/self-hosted-core/existing-tests-builder.js";
import {
  CAMPAIGN_ID,
  CANDIDATE_DEFINITIONS,
  CANDIDATE_ROOT,
  NEUTRAL_REWRITE,
  replaceExactlyOnce,
  sha256Bytes,
  TARGET_MUTATIONS,
} from "../benchmarks/self-hosted-core/campaign.js";
import {
  adaptExistingCoreTestSource,
  buildExistingTestCandidates,
  EXISTING_TESTS_CAMPAIGN_ID,
  EXISTING_TESTS_CANDIDATE_ROOT,
  EXISTING_TESTS_SNAPSHOT_COUNT,
  extractExistingCoreTests,
} from "../benchmarks/self-hosted-core/existing-tests.js";
import { parseVerificationRequest } from "../src/contracts/index.js";

const repositoryRoot = path.resolve(".");
const execFileAsync = promisify(execFile);

function operatorPlan(): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    campaignId: CAMPAIGN_ID,
    repositoryRoot,
    targetIds: TARGET_MUTATIONS.map(({ id }) => id),
    requiredAttempts: 2,
    minimumTargetWeightPermille: 1000,
    maximumSelectedCandidates: 4,
  };
}

function existingTestsOperatorPlan(): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    campaignId: EXISTING_TESTS_CAMPAIGN_ID,
    repositoryRoot,
    sourceTestCount: EXISTING_TESTS_SNAPSHOT_COUNT,
    targetIds: TARGET_MUTATIONS.map(({ id }) => id),
    requiredAttempts: 2,
    minimumTargetWeightPermille: 250,
    maximumSelectedCandidates: EXISTING_TESTS_SNAPSHOT_COUNT,
  };
}

async function withBuiltCampaign(
  run: (result: Awaited<ReturnType<typeof buildSelfHostedCampaign>>, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-self-hosted-test-"));
  try {
    const planPath = path.join(root, "operator-plan.json");
    const bytes = `${JSON.stringify(operatorPlan(), null, 2)}\n`;
    await writeFile(planPath, bytes, "utf8");
    const result = await buildSelfHostedCampaign({
      operatorPlanPath: planPath,
      expectedOperatorPlanDigest: sha256Bytes(bytes),
      outputDirectory: path.join(root, "generated"),
    });
    await run(result, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withBuiltExistingTestsCampaign(
  run: (
    result: Awaited<ReturnType<typeof buildExistingCoreTestsCampaign>>,
    root: string,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-existing-tests-test-"));
  try {
    const planPath = path.join(root, "operator-plan.json");
    const bytes = `${JSON.stringify(existingTestsOperatorPlan(), null, 2)}\n`;
    await writeFile(planPath, bytes, "utf8");
    const result = await buildExistingCoreTestsCampaign({
      operatorPlanPath: planPath,
      expectedOperatorPlanDigest: sha256Bytes(bytes),
      outputDirectory: path.join(root, "generated"),
    });
    await run(result, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function copyRepositoryWithoutDependencies(destination: string): Promise<void> {
  await cp(repositoryRoot, destination, {
    recursive: true,
    filter: (sourcePath) =>
      !path
        .relative(repositoryRoot, sourcePath)
        .split(path.sep)
        .some((segment) =>
          [".git", ".omx", ".testforge", "coverage", "graphify-out", "node_modules"].includes(
            segment,
          ),
        ),
  });
}

async function runAdapter(
  workspace: string,
  resultPath: string,
  candidateFiles: readonly string[],
): Promise<Record<string, unknown>> {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("NODE_TEST_") || name.startsWith("TESTFORGE_")) delete environment[name];
  }
  try {
    await execFileAsync(
      process.execPath,
      [
        "benchmarks/self-hosted-core/adapter.mjs",
        await realpath(path.join(repositoryRoot, "node_modules")),
      ],
      {
        cwd: workspace,
        env: {
          ...environment,
          TESTFORGE_RESULT_FILE: resultPath,
          TESTFORGE_CANDIDATE_FILES: JSON.stringify(candidateFiles),
        },
      },
    );
  } catch {
    // Negative witnesses intentionally make the adapter process non-zero.
  }
  return JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
}

describe("self-hosted core campaign", () => {
  it("requires the exact externally frozen operator plan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-plan-test-"));
    try {
      const planPath = path.join(root, "operator-plan.json");
      await writeFile(planPath, JSON.stringify(operatorPlan()), "utf8");
      await assert.rejects(
        buildSelfHostedCampaign({
          operatorPlanPath: planPath,
          expectedOperatorPlanDigest: `sha256:${"0".repeat(64)}`,
          outputDirectory: path.join(root, "generated"),
        }),
        /OPERATOR_PLAN_DIGEST_MISMATCH/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches every reusable mutation anchor exactly once", async () => {
    const source = await readFile(path.join(repositoryRoot, "src/core/index.ts"), "utf8");
    for (const mutation of [...TARGET_MUTATIONS, NEUTRAL_REWRITE]) {
      const mutated = replaceExactlyOnce(source, mutation);
      assert.notEqual(mutated, source);
      if (mutation.replacement.length > 0) {
        assert.equal(mutated.includes(mutation.replacement), true);
      }
    }
  });

  it("builds deterministic artifacts accepted by the request contract", async () => {
    await withBuiltCampaign(async (first, root) => {
      const secondDirectory = path.join(root, "generated-second");
      const planPath = path.join(root, "operator-plan.json");
      const bytes = await readFile(planPath);
      const second = await buildSelfHostedCampaign({
        operatorPlanPath: planPath,
        expectedOperatorPlanDigest: sha256Bytes(bytes),
        outputDirectory: secondDirectory,
      });
      assert.deepEqual(parseVerificationRequest(first.request), first.request);
      assert.deepEqual(second.request, first.request);
      assert.deepEqual(second.files, first.files);
      for (const file of first.files) {
        const left = await readFile(path.join(root, "generated", file), "utf8");
        const right = await readFile(path.join(secondDirectory, file), "utf8");
        assert.equal(left, right);
      }
    });
  });

  it("locks exact worlds, candidates, attempts, and execution budget", async () => {
    await withBuiltCampaign(async ({ request }) => {
      assert.deepEqual(
        request.worlds.map(({ id }) => id),
        ["reference", "neutral-comparator-rewrite", ...TARGET_MUTATIONS.map(({ id }) => id)],
      );
      assert.deepEqual(
        request.candidates.map(({ id }) => id),
        CANDIDATE_DEFINITIONS.map(({ id }) => id),
      );
      assert.equal(request.worlds.length, 6);
      assert.equal(request.candidates.length, 7);
      assert.equal(request.policy.requiredAttempts, 2);
      assert.equal(request.policy.minimumTargetWeightPermille, 1000);
      assert.equal(request.budgets.maximumExecutions, 96);
      assert.equal(
        request.budgets.maximumExecutions,
        (1 + request.candidates.length) * request.worlds.length * request.policy.requiredAttempts,
      );
    });
  });

  it("keeps candidate content separate from worlds, policy, and budgets", async () => {
    await withBuiltCampaign(async ({ request }) => {
      assert.deepEqual(request.candidateRoots, [CANDIDATE_ROOT]);
      const forbidden = [
        "maximumExecutions",
        "target-dependent-gate-order",
        "neutral-comparator-rewrite",
      ];
      for (const candidate of request.candidates) {
        for (const file of candidate.files) {
          assert.equal(file.path.startsWith(`${CANDIDATE_ROOT}/${candidate.id}/`), true);
          assert.equal(file.content.includes("../../../../src/core/index.js"), true);
          for (const token of forbidden) assert.equal(file.content.includes(token), false);
        }
      }
      assert.equal(request.adapter.kind, "testforge-command");
      assert.deepEqual(request.adapter.arguments, [
        "benchmarks/self-hosted-core/adapter.mjs",
        await realpath(path.join(repositoryRoot, "node_modules")),
      ]);
      assert.equal(request.repository.exclude.includes("dist"), false);
    });
  });

  it("runs the independent adapter liveness control without candidate attribution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-adapter-test-"));
    try {
      const workspace = path.join(root, "repository");
      await cp(repositoryRoot, workspace, {
        recursive: true,
        filter: (sourcePath) =>
          !path
            .relative(repositoryRoot, sourcePath)
            .split(path.sep)
            .some((segment) => [".git", "graphify-out", "node_modules"].includes(segment)),
      });
      const resultPath = path.join(root, "result.json");
      const environment = { ...process.env };
      for (const name of Object.keys(environment)) {
        if (name.startsWith("NODE_TEST_")) delete environment[name];
      }
      await execFileAsync(
        process.execPath,
        [
          "benchmarks/self-hosted-core/adapter.mjs",
          await realpath(path.join(repositoryRoot, "node_modules")),
        ],
        {
          cwd: workspace,
          env: {
            ...environment,
            TESTFORGE_RESULT_FILE: resultPath,
            TESTFORGE_CANDIDATE_FILES: "[]",
          },
        },
      );
      const result = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, unknown>;
      assert.equal(result.outcome, "PASS");
      assert.equal(result.attributed, false);
      assert.equal(result.candidateTestsDiscovered, 0);
      assert.equal(result.testsDiscovered, 1);
      assert.equal((await lstat(path.join(workspace, "node_modules"))).isSymbolicLink(), true);

      const candidate = CANDIDATE_DEFINITIONS.find(({ id }) => id === "weak-safe-path");
      assert.ok(candidate);
      const candidateFileDefinition = candidate.files[0];
      assert.ok(candidateFileDefinition);
      const candidateFile = path.posix.join(
        CANDIDATE_ROOT,
        candidate.id,
        candidateFileDefinition.name,
      );
      const candidatePath = path.join(workspace, ...candidateFile.split("/"));
      await mkdir(path.dirname(candidatePath), { recursive: true });
      await writeFile(candidatePath, candidateFileDefinition.content, "utf8");
      const candidateResultPath = path.join(root, "candidate-result.json");
      await execFileAsync(
        process.execPath,
        [
          "benchmarks/self-hosted-core/adapter.mjs",
          await realpath(path.join(repositoryRoot, "node_modules")),
        ],
        {
          cwd: workspace,
          env: {
            ...environment,
            TESTFORGE_RESULT_FILE: candidateResultPath,
            TESTFORGE_CANDIDATE_FILES: JSON.stringify([candidateFile]),
          },
        },
      );
      const candidateResult = JSON.parse(await readFile(candidateResultPath, "utf8")) as Record<
        string,
        unknown
      >;
      assert.equal(candidateResult.outcome, "PASS");
      assert.equal(candidateResult.attributed, true);
      assert.equal(candidateResult.candidateTestsDiscovered, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("existing core tests campaign", () => {
  it("extracts the current 36 literal tests bijectively with stable unique identities", async () => {
    const sourcePath = path.join(repositoryRoot, "tests/core.test.ts");
    const first = extractExistingCoreTests(sourcePath);
    const second = extractExistingCoreTests(sourcePath);
    assert.equal(first.length, EXISTING_TESTS_SNAPSHOT_COUNT);
    assert.deepEqual(second, first);
    assert.equal(new Set(first.map(({ id }) => id)).size, first.length);
    assert.equal(new Set(first.map(({ title }) => title)).size, first.length);
    assert.deepEqual(
      first.map(({ ordinal }) => ordinal),
      Array.from({ length: EXISTING_TESTS_SNAPSHOT_COUNT }, (_, index) => index + 1),
    );
  });

  it("rejects non-literal titles and title collisions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-extractor-witness-"));
    try {
      const sourcePath = path.join(root, "fixture.test.ts");
      await writeFile(sourcePath, 'const title = "dynamic"; it(title, () => {});', "utf8");
      assert.throws(() => extractExistingCoreTests(sourcePath), /CORE_TEST_TITLE_NOT_LITERAL/);
      await writeFile(sourcePath, 'it("same", () => {}); it("same", () => {});', "utf8");
      assert.throws(() => extractExistingCoreTests(sourcePath), /CORE_TEST_TITLE_COLLISION/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("copies the source faithfully with only the core import adapted", async () => {
    const source = await readFile(path.join(repositoryRoot, "tests/core.test.ts"), "utf8");
    const adapted = adaptExistingCoreTestSource(source);
    assert.equal(adapted.includes('import("../src/core/index.js")'), false);
    assert.equal(adapted.includes('import("../../../../src/core/index.js")'), true);
    assert.equal(adapted.replace("../../../../src/core/index.js", "../src/core/index.js"), source);
    const built = buildExistingTestCandidates(
      source,
      extractExistingCoreTests(path.join(repositoryRoot, "tests/core.test.ts")),
    );
    assert.equal(built.candidates.length, EXISTING_TESTS_SNAPSHOT_COUNT);
    for (const candidate of built.candidates) {
      assert.equal(candidate.files[0]?.content, adapted);
      const metadata = JSON.parse(candidate.files[1]?.content ?? "null") as Record<string, unknown>;
      assert.equal(metadata.candidateId, candidate.id);
      assert.equal(metadata.sourceDigest, sha256Bytes(adapted));
    }
  });

  it("reuses the six worlds and target weights with a deterministic 444-execution request", async () => {
    await withBuiltExistingTestsCampaign(async (first, root) => {
      const planPath = path.join(root, "operator-plan.json");
      const bytes = await readFile(planPath);
      const secondDirectory = path.join(root, "generated-second");
      const second = await buildExistingCoreTestsCampaign({
        operatorPlanPath: planPath,
        expectedOperatorPlanDigest: sha256Bytes(bytes),
        outputDirectory: secondDirectory,
      });
      assert.deepEqual(second.request, first.request);
      assert.deepEqual(second.files, first.files);
      assert.deepEqual(
        first.request.worlds.map(({ id, kind, weight }) => ({ id, kind, weight })),
        [
          { id: "reference", kind: "REFERENCE", weight: 0 },
          { id: NEUTRAL_REWRITE.id, kind: "NEUTRAL", weight: 0 },
          ...TARGET_MUTATIONS.map(({ id }) => ({ id, kind: "TARGET", weight: 250 })),
        ],
      );
      assert.equal(first.request.candidates.length, EXISTING_TESTS_SNAPSHOT_COUNT);
      assert.equal(first.request.policy.requiredAttempts, 2);
      assert.equal(first.request.policy.minimumTargetWeightPermille, 250);
      assert.equal(first.request.policy.maximumSelectedCandidates, EXISTING_TESTS_SNAPSHOT_COUNT);
      assert.equal(first.request.budgets.maximumExecutions, 444);
      assert.deepEqual(first.request.candidateRoots, [EXISTING_TESTS_CANDIDATE_ROOT]);
      assert.deepEqual(first.request.repository.exclude, [
        "node_modules",
        ".git",
        "graphify-out",
        "RESULT-existing-tests-v1.md",
      ]);
      for (const file of first.files) {
        assert.equal(
          await readFile(path.join(root, "generated", file), "utf8"),
          await readFile(path.join(secondDirectory, file), "utf8"),
        );
      }
    });
  });

  it("attributes the selected title and keeps zero, multiple, syntax, and crash runs as non-kills", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-selected-adapter-test-"));
    try {
      const workspace = path.join(root, "repository");
      await copyRepositoryWithoutDependencies(workspace);
      const source = await readFile(path.join(repositoryRoot, "tests/core.test.ts"), "utf8");
      const candidate = buildExistingTestCandidates(
        source,
        extractExistingCoreTests(path.join(repositoryRoot, "tests/core.test.ts")),
      ).candidates[0];
      assert.ok(candidate);
      const candidateDirectory = path.posix.join(EXISTING_TESTS_CANDIDATE_ROOT, candidate.id);
      for (const file of candidate.files) {
        const target = path.join(workspace, ...candidateDirectory.split("/"), file.name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, "utf8");
      }
      const candidateFiles = candidate.files.map((file) =>
        path.posix.join(candidateDirectory, file.name),
      );
      const exact = await runAdapter(workspace, path.join(root, "exact.json"), candidateFiles);
      assert.equal(exact.outcome, "PASS");
      assert.equal(exact.candidateTestsDiscovered, 1);
      assert.equal(exact.attributed, true);

      const durationCase = buildExistingTestCandidates(
        source,
        extractExistingCoreTests(path.join(repositoryRoot, "tests/core.test.ts")),
      ).candidates.find((item) => {
        const metadata = JSON.parse(item.files[1]?.content ?? "null") as Record<string, unknown>;
        return metadata.title === "excludes volatile durations from the decision digest";
      });
      assert.ok(durationCase);
      const durationDirectory = path.posix.join(EXISTING_TESTS_CANDIDATE_ROOT, durationCase.id);
      for (const file of durationCase.files) {
        const target = path.join(workspace, ...durationDirectory.split("/"), file.name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, "utf8");
      }
      const corePath = path.join(workspace, "src/core/index.ts");
      const durationMutation = TARGET_MUTATIONS.find(
        ({ id }) => id === "target-duration-in-decision-digest",
      );
      assert.ok(durationMutation);
      await writeFile(
        corePath,
        replaceExactlyOnce(await readFile(corePath, "utf8"), durationMutation),
        "utf8",
      );
      const assertionFailure = await runAdapter(
        workspace,
        path.join(root, "assertion.json"),
        durationCase.files.map((file) => path.posix.join(durationDirectory, file.name)),
      );
      assert.equal(assertionFailure.outcome, "ASSERTION_FAILURE");
      assert.equal(assertionFailure.candidateTestsDiscovered, 1);
      assert.equal(assertionFailure.attributed, true);

      const selectionFile = candidateFiles[1];
      assert.ok(selectionFile);
      const selectionPath = path.join(workspace, ...selectionFile.split("/"));
      const selection = JSON.parse(await readFile(selectionPath, "utf8")) as Record<
        string,
        unknown
      >;
      const sourceFile = candidateFiles[0];
      assert.ok(sourceFile);
      const sourcePath = path.join(workspace, ...sourceFile.split("/"));
      const selectedTitle = selection.title;
      assert.equal(typeof selectedTitle, "string");
      const writeRuntimeFixture = async (content: string): Promise<void> => {
        await writeFile(sourcePath, content, "utf8");
        selection.sourceDigest = sha256Bytes(content);
        await writeFile(selectionPath, `${JSON.stringify(selection, null, 2)}\n`, "utf8");
      };

      await writeRuntimeFixture(
        'import { it } from "node:test"; it("different test", () => {});\n',
      );
      const zero = await runAdapter(workspace, path.join(root, "zero.json"), candidateFiles);
      assert.equal(zero.outcome, "NO_TEST_DISCOVERED");
      assert.equal(zero.candidateTestsDiscovered, 0);
      assert.equal(zero.attributed, false);

      await writeRuntimeFixture(
        `import { it } from "node:test"; it(${JSON.stringify(selectedTitle)}, () => {}); it(${JSON.stringify(selectedTitle)}, () => {});\n`,
      );
      const multiple = await runAdapter(
        workspace,
        path.join(root, "multiple.json"),
        candidateFiles,
      );
      assert.equal(multiple.outcome, "PROCESS_CRASH");
      assert.equal(multiple.candidateTestsDiscovered, 2);
      assert.equal(multiple.attributed, false);

      await writeRuntimeFixture('import { it } from "node:test"; it("unterminated, () => {});\n');
      const syntax = await runAdapter(workspace, path.join(root, "syntax.json"), candidateFiles);
      assert.notEqual(syntax.outcome, "ASSERTION_FAILURE");
      assert.equal(syntax.attributed, false);

      await writeRuntimeFixture(
        `import { it } from "node:test"; it(${JSON.stringify(selectedTitle)}, () => { throw new Error("boom"); });\n`,
      );
      const crash = await runAdapter(workspace, path.join(root, "crash.json"), candidateFiles);
      assert.equal(crash.outcome, "PROCESS_CRASH");
      assert.equal(crash.candidateTestsDiscovered, 1);
      assert.equal(crash.attributed, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
