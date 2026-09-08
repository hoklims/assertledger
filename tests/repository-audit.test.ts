import assert from "node:assert/strict";
import childProcess, { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import { parseRepositoryAudit, repositoryAuditJsonSchema } from "../src/contracts/index.js";
import { auditRepository } from "../src/engine/index.js";
import { AssertLedger } from "../src/sdk/index.js";
import { runCli } from "../src/cli.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-audit-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await writeFile(
    path.join(root, "src", "choice.ts"),
    "export function choose(x: boolean) { if (x) return 1; return 0; }\nexport const unused = 2;\n// export const commentGhost = 1;\nconst prose = 'export function stringGhost() {}';\n",
  );
  await writeFile(
    path.join(root, "tests", "choice.test.ts"),
    "import { choose } from '../src/choice.js';\nassert.ok(choose(true));\nassert.equal(typeof choose(true), 'number');\nexpect(choose(true)).toBeDefined();\nexpect(() => choose(true)).not.toThrow();\n// expect(commentGhost).toBeDefined();\nconst prose = 'assert.ok(stringGhost)';\n",
  );
  return root;
}

function request(root: string) {
  return {
    schemaVersion: "1.0.0",
    repository: { root, exclude: [] },
    adapter: {
      kind: "node-test",
      executable: process.execPath,
      baseTestFiles: ["tests/base.test.js"],
    },
    isolation: {
      kind: "trusted-local",
      acknowledgedUnsafeExecution: true,
      environmentAllowlist: [],
    },
    candidateRoots: ["tests/candidates"],
    budgets: {
      maximumCandidates: 100,
      maximumWorlds: 10,
      maximumExecutions: 1000,
      maximumRepositoryFiles: 1000,
      maximumRepositoryBytes: 1_000_000,
      maximumWorldOverlayBytes: 1_000_000,
      maximumCandidateBytes: 1_000_000,
      maximumTotalCandidateBytes: 1_000_000,
      timeoutMsPerExecution: 1000,
      maximumOutputBytes: 2048,
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 2,
      minimumTargetWeightPermille: 1,
      maximumSelectedCandidates: 36,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds: [
      {
        id: "reference",
        kind: "REFERENCE",
        required: true,
        weight: 0,
        provenance: "fixture",
        files: [],
      },
      {
        id: "target",
        kind: "TARGET",
        required: true,
        weight: 1,
        provenance: "fixture",
        files: [{ path: "src/x.ts", content: "x" }],
      },
      {
        id: "neutral",
        kind: "NEUTRAL",
        required: true,
        weight: 0,
        provenance: "fixture",
        files: [],
      },
      {
        id: "target-2",
        kind: "TARGET",
        required: false,
        weight: 1,
        provenance: "fixture",
        files: [],
      },
      {
        id: "target-3",
        kind: "TARGET",
        required: false,
        weight: 1,
        provenance: "fixture",
        files: [],
      },
      {
        id: "target-4",
        kind: "TARGET",
        required: false,
        weight: 1,
        provenance: "fixture",
        files: [],
      },
    ],
    candidates: Array.from({ length: 36 }, (_, index) => ({
      id: `candidate-${index}`,
      files: [{ path: `tests/candidates/${index}.test.js`, content: "x" }],
    })),
  };
}

describe("repository audit v1", () => {
  it("publishes a strict factual schema without score, note, or verdict properties", () => {
    const schemaText = JSON.stringify(repositoryAuditJsonSchema());
    assert.doesNotMatch(schemaText, /"(?:score|note|verdict)"/u);
    assert.match(schemaText, /repository-audit\.v1/u);
  });

  it("computes exact decimal BigInt campaign bounds and forces unsafe acknowledgement false", async () => {
    const root = await fixture();
    const verificationRequest = request(root);
    verificationRequest.adapter.executable = path.join(root, "adapter-must-not-run.exe");
    const result = await auditRepository(root, { noGit: true, verificationRequest });
    assert.equal(result.cost.executions, "444");
    assert.equal(result.cost.controlExecutions, "12");
    assert.equal(result.cost.candidateExecutions, "432");
    assert.equal(result.verificationRequest?.isolation.acknowledgedUnsafeExecution, false);
    assert.equal(BigInt(result.cost.capturedStreamLimitBytes), 444n * 2048n * 2n);
    parseRepositoryAudit(result);
  });

  it("keeps cost bounds invariant under candidate and world permutation", async () => {
    const root = await fixture();
    const original = request(root);
    const permuted = {
      ...original,
      worlds: [...original.worlds].reverse(),
      candidates: [...original.candidates].reverse(),
    };
    const [left, right] = await Promise.all([
      auditRepository(root, { noGit: true, verificationRequest: original }),
      auditRepository(root, { noGit: true, verificationRequest: permuted }),
    ]);
    assert.deepEqual(left.cost, right.cost);
  });

  it("rejects structurally valid audits whose facts, costs, or Git null semantics disagree", async () => {
    const root = await fixture();
    const result = await auditRepository(root, { noGit: true, verificationRequest: request(root) });
    const cases = [
      { ...structuredClone(result), fileCount: result.fileCount + 1 },
      {
        ...structuredClone(result),
        cost: { ...result.cost, executions: (BigInt(result.cost.executions) + 1n).toString() },
      },
      {
        ...structuredClone(result),
        git: { ...result.git, supported: true, truncated: true },
        files: result.files.map((file) => ({ ...file, commitsInWindow: 0, fixCommitsInWindow: 0 })),
      },
      {
        ...structuredClone(result),
        verificationRequest: {
          ...result.verificationRequest,
          repository: { root: path.dirname(root), exclude: [] },
        },
      },
      {
        ...structuredClone(result),
        root: ".",
        verificationRequest: {
          ...result.verificationRequest,
          repository: { root: ".", exclude: [] },
        },
      },
      {
        ...structuredClone(result),
        reasonCodes: result.reasonCodes.filter((code) => code !== "GIT_DISABLED"),
        git: { ...result.git, truncated: true },
      },
      {
        ...structuredClone(result),
        git: { ...result.git, shallow: false },
      },
      {
        ...structuredClone(result),
        files: result.files.map((file) =>
          file.path === "tests/choice.test.ts"
            ? { ...file, weakAssertions: [...(file.weakAssertions ?? [])].reverse() }
            : file,
        ),
      },
    ];
    for (const inconsistent of cases) {
      assert.throws(() => parseRepositoryAudit(inconsistent), /REPOSITORY_AUDIT_/u);
    }
  });

  it("reports syntax-only signals without calling a test runner", async () => {
    const root = await fixture();
    const result = await auditRepository(root, { noGit: true });
    const source = result.files.find((file) => file.path === "src/choice.ts");
    const test = result.files.find((file) => file.path === "tests/choice.test.ts");
    assert.equal(source?.decisionPoints, 1);
    assert.deepEqual(source?.declaredExports, ["choose", "unused"]);
    assert.deepEqual(source?.noObservedTestReference, ["unused"]);
    assert.deepEqual(source?.associatedTests, ["tests/choice.test.ts"]);
    assert.deepEqual(test?.weakAssertions, [
      { category: "DEFINEDNESS_ONLY", count: 1 },
      { category: "NON_THROW_ONLY", count: 1 },
      { category: "TRUTHINESS_ONLY", count: 1 },
      { category: "TYPE_ONLY", count: 1 },
    ]);
    const unsupported = result.files.find((file) => file.path === "README.md");
    assert.equal(unsupported?.supported, false);
    assert.equal(unsupported?.decisionPoints, null);
    assert.equal(unsupported?.declaredExports, null);
    assert.equal(unsupported?.noObservedTestReference, null);
    assert.equal(unsupported?.weakAssertions, null);
    assert.equal(result.verificationRequest, null);
    assert(result.reasonCodes.includes("VERIFICATION_REQUEST_UNAVAILABLE"));
  });

  it("detects a repository mutation between inventories", async () => {
    const root = await fixture();
    await assert.rejects(
      auditRepository(root, {
        noGit: true,
        afterInitialInventory: () =>
          writeFile(path.join(root, "src", "late.ts"), "export const late = true;\n"),
      }),
      /REPOSITORY_CHANGED_DURING_AUDIT/u,
    );
  });

  it("anchors the 90-day Git window to HEAD and recognizes explicit fix messages", async () => {
    const root = await fixture();
    const git = async (args: string[], date?: string) => {
      await execFileAsync("git", args, {
        cwd: root,
        env: date
          ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
          : process.env,
      });
    };
    await git(["init"]);
    await git(["config", "user.email", "audit@example.invalid"]);
    await git(["config", "user.name", "Audit Fixture"]);
    await git(["add", "."]);
    await git(["commit", "-m", "initial"], "2020-01-01T00:00:00Z");
    await writeFile(path.join(root, "src", "choice.ts"), "export const choose = () => true;\n");
    await git(["add", "."]);
    await git(["commit", "-m", "fix: repair choice"], "2020-04-01T00:00:00Z");
    await writeFile(path.join(root, "README.md"), "head anchor\n");
    await git(["add", "."]);
    await git(["commit", "-m", "docs"], "2020-04-02T00:00:00Z");
    const result = await auditRepository(root);
    assert.equal(result.git.headTimestamp, 1_585_785_600);
    assert.equal(result.git.supported, true);
    const source = result.files.find((file) => file.path === "src/choice.ts");
    assert.equal(source?.commitsInWindow, 1);
    assert.equal(source?.fixCommitsInWindow, 1);
  });

  it("does not spawn one Git history process per repository file", async (context) => {
    const root = await fixture();
    for (let index = 0; index < 40; index += 1) {
      await writeFile(
        path.join(root, "src", `module-${index}.ts`),
        `export const value${index} = ${index};\n`,
      );
    }
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "audit@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Audit Fixture"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });

    const spawnSpy = context.mock.method(childProcess, "spawn");
    syncBuiltinESMExports();
    try {
      const result = await auditRepository(root);
      const historyProcesses = spawnSpy.mock.calls.filter(
        ({ arguments: args }) =>
          args[0] === "git" && Array.isArray(args[1]) && args[1][0] === "log",
      );

      assert.equal(result.git.supported, true);
      assert.equal(result.files.length, 43);
      assert(result.files.every((file) => file.commitsInWindow === 1));
      assert.equal(historyProcesses.length, 2);
    } finally {
      spawnSpy.mock.restore();
      syncBuiltinESMExports();
    }
  });

  it("exposes audit through the provider-neutral SDK", async () => {
    const root = await fixture();
    const ledger = new AssertLedger();
    const result = await ledger.audit(root, { noGit: true });
    assert.equal(result.schemaVersion, "1.0.0");
  });

  it("discovers and emits a verification request with deterministic CLI exit codes", async () => {
    const root = await fixture();
    const messages = { stdout: "", stderr: "" };
    const io = {
      cwd: root,
      readStdin: async () => "",
      writeStdout: (text: string) => {
        messages.stdout += text;
      },
      writeStderr: (text: string) => {
        messages.stderr += text;
      },
    };
    assert.equal(
      await runCli(["audit", ".", "--emit-verification-request", "--no-git", "--json"], io),
      3,
    );
    await writeFile(path.join(root, "assertledger.request.json"), JSON.stringify(request(root)));
    messages.stdout = "";
    assert.equal(
      await runCli(["audit", ".", "--emit-verification-request", "--no-git", "--json"], io),
      0,
    );
    const emitted = JSON.parse(messages.stdout) as ReturnType<typeof request>;
    assert.equal(emitted.isolation.acknowledgedUnsafeExecution, false);
    messages.stdout = "";
    assert.equal(await runCli(["audit", ".", "--no-git", "--json"], io), 0);
    assert.equal(
      (JSON.parse(messages.stdout) as { cost: { executions: string } }).cost.executions,
      "444",
    );
    await writeFile(path.join(root, "invalid.json"), "{}\n");
    assert.equal(
      await runCli(["audit", ".", "--verification-request", "invalid.json", "--json"], io),
      4,
    );
    const otherRoot = await fixture();
    await writeFile(path.join(root, "wrong-root.json"), JSON.stringify(request(otherRoot)));
    assert.equal(
      await runCli(["audit", ".", "--verification-request", "wrong-root.json", "--json"], io),
      4,
    );
  });
});
