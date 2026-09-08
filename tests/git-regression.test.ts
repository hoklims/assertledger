import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { runCli } from "../src/cli.js";
import { replayEvidenceManifest } from "../src/core/index.js";
import {
  batchOutputLimitForTesting,
  decodeGitTextForTesting,
  parseGitTreeForTesting,
  qualifyGitRegression,
  renderGitRegressionSummary,
  runBoundedProcessForTesting,
} from "../src/engine/git-regression.js";
import { runProcess } from "../src/engine/index.js";
import { createAssertLedgerServer } from "../src/mcp/index.js";
import { AssertLedger } from "../src/sdk/index.js";

const temporaryDirectories: string[] = [];

async function runGit(root: string, args: string[]): Promise<string> {
  const result = await runProcess({
    executable: "git",
    args,
    cwd: root,
    environment: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
    timeoutMs: 5_000,
    maximumOutputBytes: 65_536,
  });
  assert.equal(result.outcome, "PASS", result.stderr.text);
  assert.equal(result.exitCode, 0, result.stderr.text);
  return result.stdout.text.trim();
}

async function commit(root: string, message: string): Promise<string> {
  await runGit(root, ["add", "."]);
  return commitIndex(root, message);
}

async function commitIndex(root: string, message: string): Promise<string> {
  await runGit(root, [
    "-c",
    "user.name=AssertLedger Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    message,
  ]);
  return runGit(root, ["rev-parse", "HEAD"]);
}

async function fixture(candidateContent?: string): Promise<{
  root: string;
  before: string;
  after: string;
  neutral: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-git-regression-"));
  temporaryDirectories.push(root);
  await runGit(root, ["init"]);
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(root, "subject.js"), "export const total = () => 1;\n");
  await writeFile(
    path.join(root, "base.test.js"),
    'import test from "node:test"; import assert from "node:assert/strict"; test("base",()=>assert.equal(1,1));\n',
  );
  const before = await commit(root, "bug");
  await writeFile(path.join(root, "subject.js"), "export const total = () => 2;\n");
  await commit(root, "fix");
  await writeFile(
    path.join(root, "candidate.test.js"),
    candidateContent ??
      'import test from "node:test"; import assert from "node:assert/strict"; import { total } from "./subject.js"; test("regression",()=>assert.equal(total(),2));\n',
  );
  const neutral = await commit(root, "candidate");
  return { root, before, after: neutral, neutral };
}

function optionsFor(
  fixtureValue: { root: string; before: string; after: string; neutral: string },
  out = ".assertledger/evidence",
) {
  return {
    repository: fixtureValue.root,
    before: fixtureValue.before,
    after: fixtureValue.after,
    neutral: fixtureValue.neutral,
    neutralReason: "explicit repeated control",
    test: "candidate.test.js",
    baseTests: ["base.test.js"],
    out,
    allowUnsafeExecution: true,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

describe("Git regression qualification", () => {
  it("offers a confined high-level MCP check only with the operator capability", async () => {
    const value = await fixture();
    const options = optionsFor(value, "mcp-evidence");
    const { allowUnsafeExecution: _capability, ...request } = options;
    const readOnly = createAssertLedgerServer({ allowedRepositoryRoots: [value.root] });
    assert.equal(readOnly.toolInputSchemaJson("assertledger_check"), undefined);
    const server = createAssertLedgerServer({
      allowUnsafeExecution: true,
      allowedRepositoryRoots: [value.root],
    });
    const schema = server.toolInputSchemaJson("assertledger_check");
    assert.ok(schema);
    assert.equal(schema.additionalProperties, false);
    assert.equal((schema.properties as Record<string, unknown>).allowUnsafeExecution, undefined);
    assert.deepEqual(server.toolInputSchemaJson("testforge_check"), schema);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "git-check-client", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const outside = await fixture();
      const rejectedRoot = await client.callTool({
        name: "assertledger_check",
        arguments: { ...request, repository: outside.root },
      });
      assert.equal(rejectedRoot.isError, true);
      assert.match(JSON.stringify(rejectedRoot.content), /MCP_REPOSITORY_ROOT_FORBIDDEN/);
      const rejectedOutput = await client.callTool({
        name: "assertledger_check",
        arguments: { ...request, out: "../outside-evidence" },
      });
      assert.equal(rejectedOutput.isError, true);
      const result = await client.callTool({ name: "assertledger_check", arguments: request });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      const manifest = JSON.parse((result.content[0] as { text: string }).text);
      assert.equal(manifest.decision.status, "VERIFIED");
      assert.equal(replayEvidenceManifest(manifest).valid, true);
      assert.equal(
        (await stat(path.join(value.root, "mcp-evidence/manifest.json"))).isFile(),
        true,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects portable directory-prefix collisions and preserves BOM bytes while decoding Git data", () => {
    const oid = "a".repeat(40);
    const record = (entryPath: Buffer) =>
      Buffer.concat([Buffer.from(`100644 blob ${oid}\t`, "ascii"), entryPath, Buffer.from([0])]);
    assert.throws(
      () =>
        parseGitTreeForTesting(
          Buffer.concat([record(Buffer.from("A/x.js")), record(Buffer.from("a/y.js"))]),
        ),
      /PORTABLE_PATH_COLLISION/,
    );
    assert.throws(
      () =>
        parseGitTreeForTesting(
          Buffer.concat([record(Buffer.from("a")), record(Buffer.from("a/x.js"))]),
        ),
      /GIT_PATH_TOPOLOGY_COLLISION/,
    );
    assert.throws(
      () => parseGitTreeForTesting(record(Buffer.from([0xc3, 0x28]))),
      /GIT_PATH_INVALID_UTF8/,
    );
    const bomPath = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x2e, 0x6a, 0x73]);
    assert.deepEqual([...parseGitTreeForTesting(record(bomPath)).keys()], ["\uFEFFa.js"]);
    const bomText = Buffer.from([
      0xef, 0xbb, 0xbf, 0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x20, 0x7b, 0x7d, 0x3b,
    ]);
    const decoded = decodeGitTextForTesting(bomText);
    assert.equal(decoded.charCodeAt(0), 0xfeff);
    assert.deepEqual(Buffer.from(decoded, "utf8"), bomText);
    assert.throws(
      () => decodeGitTextForTesting(Buffer.from([0xc3, 0x28])),
      /GIT_TEXT_INVALID_UTF8/,
    );
  });

  it("requires the SDK unsafe capability to be the boolean true", async () => {
    await assert.rejects(
      qualifyGitRegression({
        repository: path.join(os.tmpdir(), "missing-git-regression-repository"),
        before: "before",
        after: "after",
        neutral: "neutral",
        neutralReason: "explicit control",
        test: "candidate.test.js",
        baseTests: ["base.test.js"],
        out: "evidence",
        allowUnsafeExecution: "yes" as unknown as boolean,
      }),
      /GIT_REGRESSION_UNSAFE_EXECUTION_NOT_ALLOWED/,
    );
  });

  it("rejects blank and C1 neutral reasons before repository access", async () => {
    for (const neutralReason of ["   ", "control\u0085reason"]) {
      await assert.rejects(
        qualifyGitRegression({
          repository: path.join(os.tmpdir(), "missing-git-regression-repository"),
          before: "before",
          after: "after",
          neutral: "neutral",
          neutralReason,
          test: "candidate.test.js",
          baseTests: ["base.test.js"],
          out: "evidence",
          allowUnsafeExecution: true,
        }),
        /GIT_REGRESSION_NEUTRAL_REASON_INVALID/,
      );
    }
  });

  it("derives a bounded batch buffer that includes every SHA-256 metadata header", () => {
    const sizes = Array.from({ length: 30_000 }, () => 0);
    assert.equal(batchOutputLimitForTesting(sizes, 64), 30_000 * (64 + 1 + 4 + 1 + 7 + 2));
    assert.ok(batchOutputLimitForTesting(sizes, 64) > 1_048_576);
  });

  it("settles after the bounded grace when a descendant keeps process streams open", async () => {
    const started = Date.now();
    await assert.rejects(
      runBoundedProcessForTesting({
        executable: process.execPath,
        args: [
          "-e",
          "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],{stdio:['ignore',1,2]}); setTimeout(()=>{},2000)",
        ],
        cwd: process.cwd(),
        timeoutMs: 250,
      }),
      /GIT_PROCESS_TIMEOUT/,
    );
    assert.ok(Date.now() - started < 1_000);
  });

  it("qualifies a committed node:test regression and publishes a replayable completion marker", async () => {
    const { root, before, after, neutral } = await fixture();
    await writeFile(path.join(root, "subject.js"), "dirty checkout content must be ignored\n");
    const headBefore = await runGit(root, ["rev-parse", "HEAD"]);
    const indexBefore = await runGit(root, ["diff", "--cached", "--binary"]);
    const manifest = await new AssertLedger().checkGitRegression({
      repository: root,
      before,
      after,
      neutral,
      neutralReason: "same fixed tree repeated as an explicit stability control",
      test: "candidate.test.js",
      baseTests: ["base.test.js"],
      out: ".assertledger/evidence",
      allowUnsafeExecution: true,
    });

    assert.equal(manifest.decision.status, "VERIFIED");
    assert.deepEqual(manifest.decision.selectedCandidateIds, ["git-regression-candidate"]);
    assert.equal(replayEvidenceManifest(manifest).valid, true);
    assert.deepEqual(
      manifest.observations
        .filter(
          (observation) =>
            observation.candidateId === "git-regression-candidate" &&
            observation.worldId === "known-bug",
        )
        .map((observation) => ({
          outcome: observation.outcome,
          attributed: observation.attributed,
        })),
      [
        { outcome: "ASSERTION_FAILURE", attributed: true },
        { outcome: "ASSERTION_FAILURE", attributed: true },
      ],
    );
    assert.equal((await stat(path.join(root, ".assertledger", "evidence"))).isDirectory(), true);
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(root, ".assertledger", "evidence", "manifest.json"), "utf8"),
      ),
      manifest,
    );
    assert.match(
      await readFile(path.join(root, ".assertledger", "evidence", "summary.md"), "utf8"),
      /UNSANDBOXED/,
    );
    const rendered = renderGitRegressionSummary(manifest, {
      repository: root,
      before,
      after,
      neutral,
      neutralReason: "same fixed tree repeated as an explicit stability control",
      test: "candidate.test.js",
      baseTests: ["base.test.js"],
      out: ".assertledger/evidence",
      allowUnsafeExecution: true,
    });
    assert.match(rendered, new RegExp(before));
    assert.match(rendered, new RegExp(after));
    assert.match(rendered, /Reason codes:/);
    assert.match(rendered, /Known-bug observations:/);
    assert.match(rendered, /Limitations:/);
    assert.match(rendered, /assertledger replay/);
    assert.ok(
      rendered.includes(
        `assertledger replay '${path.join(root, ".assertledger", "evidence", "manifest.json")}' --json`,
      ),
      "Replay guidance must quote the absolute manifest path without Markdown escapes inside code.",
    );
    assert.equal(
      await readFile(path.join(root, ".assertledger", "evidence", "summary.md"), "utf8"),
      rendered,
    );
    assert.equal(await runGit(root, ["rev-parse", "HEAD"]), headBefore);
    assert.equal(await runGit(root, ["diff", "--cached", "--binary"]), indexBefore);
    assert.equal(
      await readFile(path.join(root, "subject.js"), "utf8"),
      "dirty checkout content must be ignored\n",
    );
  });

  it("rejects execution without an independent unsafe capability", async () => {
    const { root, before, after, neutral } = await fixture();
    await assert.rejects(
      qualifyGitRegression({
        repository: root,
        before,
        after,
        neutral,
        neutralReason: "explicit repeated control",
        test: "candidate.test.js",
        baseTests: ["base.test.js"],
        out: ".assertledger/evidence",
        allowUnsafeExecution: false,
      }),
      /GIT_REGRESSION_UNSAFE_EXECUTION_NOT_ALLOWED/,
    );
  });

  it("does not count a generic process crash as a target kill", async () => {
    const { root, before, after, neutral } = await fixture(
      'import test from "node:test"; test("generic crash",()=>{ throw new Error("boom"); });\n',
    );
    const manifest = await qualifyGitRegression({
      repository: root,
      before,
      after,
      neutral,
      neutralReason: "explicit repeated control",
      test: "candidate.test.js",
      baseTests: ["base.test.js"],
      out: ".assertledger/crash-evidence",
      allowUnsafeExecution: true,
    });
    assert.notEqual(manifest.decision.status, "VERIFIED");
    assert.equal(
      manifest.observations.some(
        (observation) =>
          observation.candidateId === "git-regression-candidate" &&
          observation.worldId === "known-bug" &&
          observation.outcome === "ASSERTION_FAILURE" &&
          observation.attributed,
      ),
      false,
    );
  });

  it("rejects a weak test that does not detect the known bug", async () => {
    const fixtureValue = await fixture(
      'import test from "node:test"; import assert from "node:assert/strict"; test("weak",()=>assert.equal(1,1));\n',
    );
    const manifest = await qualifyGitRegression(
      optionsFor(fixtureValue, ".assertledger/weak-evidence"),
    );
    assert.equal(manifest.decision.status, "REJECTED");
    assert.equal(replayEvidenceManifest(manifest).valid, true);
    assert.deepEqual(manifest.decision.selectedCandidateIds, []);
  });

  it("rejects missing revisions and pre-existing output before campaign execution", async () => {
    const { root, before, after, neutral } = await fixture();
    await assert.rejects(
      qualifyGitRegression({
        repository: root,
        before: "missing-revision",
        after,
        neutral,
        neutralReason: "explicit repeated control",
        test: "candidate.test.js",
        baseTests: ["base.test.js"],
        out: ".assertledger/evidence",
        allowUnsafeExecution: true,
      }),
      /GIT_REVISION_INVALID/,
    );
    await writeFile(path.join(root, "occupied"), "already exists\n");
    await assert.rejects(
      qualifyGitRegression({
        repository: root,
        before,
        after,
        neutral,
        neutralReason: "explicit repeated control",
        test: "candidate.test.js",
        baseTests: ["base.test.js"],
        out: "occupied",
        allowUnsafeExecution: true,
      }),
      /GIT_REGRESSION_OUTPUT_EXISTS/,
    );
  });

  it("rejects Git metadata output paths without creating metadata content", async () => {
    const gitOutput = await fixture();
    for (const out of [".git/evidence", ".GIT/other-evidence"]) {
      await assert.rejects(
        qualifyGitRegression(optionsFor(gitOutput, out)),
        /GIT_REGRESSION_OUTPUT_METADATA_FORBIDDEN/,
      );
    }
    await assert.rejects(stat(path.join(gitOutput.root, ".git", "evidence")), { code: "ENOENT" });
  });

  it("rejects a base path that discovers no tests and publishes no manifest", async () => {
    const noBaseTest = await fixture();
    const output = path.join(noBaseTest.root, ".assertledger", "no-base-tests");
    await assert.rejects(
      qualifyGitRegression({
        ...optionsFor(noBaseTest, ".assertledger/no-base-tests"),
        baseTests: ["package.json"],
      }),
      /GIT_BASE_TESTS_NOT_DISCOVERED/,
    );
    await assert.rejects(stat(output), { code: "ENOENT" });
  });

  it("rejects identical trees, non-ancestor histories, topology drift, base drift, and executable entries before execution", async () => {
    const identical = await fixture();
    await assert.rejects(
      qualifyGitRegression({ ...optionsFor(identical), before: identical.after }),
      /GIT_BEFORE_AFTER_IDENTICAL/,
    );

    const nonAncestor = await fixture();
    const beforeTree = await runGit(nonAncestor.root, [
      "rev-parse",
      `${nonAncestor.before}^{tree}`,
    ]);
    const orphan = await runGit(nonAncestor.root, [
      "-c",
      "user.name=AssertLedger Test",
      "-c",
      "user.email=test@example.invalid",
      "commit-tree",
      beforeTree,
      "-m",
      "unrelated",
    ]);
    await assert.rejects(
      qualifyGitRegression({ ...optionsFor(nonAncestor), before: orphan }),
      /GIT_BEFORE_NOT_ANCESTOR_OF_AFTER/,
    );

    const topology = await fixture();
    await writeFile(path.join(topology.root, "unexpected.js"), "export {};\n");
    topology.after = await commit(topology.root, "unsupported source addition");
    topology.neutral = topology.after;
    await assert.rejects(
      qualifyGitRegression(optionsFor(topology)),
      /GIT_UNSUPPORTED_TOPOLOGY_DRIFT/,
    );

    const baseDrift = await fixture();
    await writeFile(
      path.join(baseDrift.root, "base.test.js"),
      'import test from "node:test"; import assert from "node:assert/strict"; test("changed base",()=>assert.equal(2,2));\n',
    );
    baseDrift.after = await commit(baseDrift.root, "unsupported base drift");
    baseDrift.neutral = baseDrift.after;
    await assert.rejects(
      qualifyGitRegression(optionsFor(baseDrift)),
      /GIT_BASE_TEST_DRIFT_UNSUPPORTED/,
    );

    const executable = await fixture();
    await runGit(executable.root, ["update-index", "--chmod=+x", "subject.js"]);
    executable.after = await commitIndex(executable.root, "unsupported executable mode");
    executable.neutral = executable.after;
    await assert.rejects(
      qualifyGitRegression(optionsFor(executable)),
      /GIT_UNSUPPORTED_ENTRY_MODE/,
    );
  });

  it("rejects symlinks and package dependency boundaries before execution", async () => {
    const linked = await fixture();
    const blob = await runGit(linked.root, ["rev-parse", `${linked.after}:subject.js`]);
    await runGit(linked.root, [
      "update-index",
      "--add",
      "--cacheinfo",
      `120000,${blob},link-to-subject`,
    ]);
    linked.after = await commitIndex(linked.root, "unsupported symlink");
    linked.neutral = linked.after;
    await assert.rejects(qualifyGitRegression(optionsFor(linked)), /GIT_UNSUPPORTED_ENTRY_MODE/);

    const dependencies = await fixture();
    await writeFile(
      path.join(dependencies.root, "package.json"),
      '{"type":"module","dependencies":{"left-pad":"1.3.0"}}\n',
    );
    dependencies.after = await commit(dependencies.root, "unsupported dependency drift");
    dependencies.neutral = dependencies.after;
    await assert.rejects(
      qualifyGitRegression(optionsFor(dependencies)),
      /GIT_PACKAGE_IDENTITY_DRIFT_UNSUPPORTED/,
    );
  });

  it("rejects an oversized Git blob from metadata before requesting its content", async () => {
    const oversized = await fixture();
    await writeFile(path.join(oversized.root, "subject.js"), Buffer.alloc(8_388_609, 0x61));
    oversized.after = await commit(oversized.root, "oversized blob");
    oversized.neutral = oversized.after;
    await assert.rejects(
      qualifyGitRegression(optionsFor(oversized)),
      /GIT_BLOB_BUDGET_EXCEEDED_BEFORE_CONTENT/,
    );
  });

  it("rejects invalid UTF-8 in the committed candidate and changed source overlays", async () => {
    const invalidCandidate = await fixture();
    await writeFile(
      path.join(invalidCandidate.root, "candidate.test.js"),
      Buffer.from([0xc3, 0x28]),
    );
    invalidCandidate.after = await commit(invalidCandidate.root, "invalid candidate bytes");
    invalidCandidate.neutral = invalidCandidate.after;
    await assert.rejects(
      qualifyGitRegression(optionsFor(invalidCandidate)),
      /GIT_REGRESSION_CANDIDATE_BUDGET_EXCEEDED_INVALID_UTF8/,
    );

    const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-git-invalid-source-"));
    temporaryDirectories.push(root);
    await runGit(root, ["init"]);
    await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
    await writeFile(
      path.join(root, "base.test.js"),
      'import test from "node:test"; import assert from "node:assert/strict"; test("base",()=>assert.equal(1,1));\n',
    );
    await writeFile(path.join(root, "subject.js"), Buffer.from([0xc3, 0x28]));
    const before = await commit(root, "invalid source in bug revision");
    await writeFile(path.join(root, "subject.js"), "export const total = () => 2;\n");
    await writeFile(
      path.join(root, "candidate.test.js"),
      'import test from "node:test"; import assert from "node:assert/strict"; import { total } from "./subject.js"; test("regression",()=>assert.equal(total(),2));\n',
    );
    const after = await commit(root, "valid fixed revision");
    await assert.rejects(
      qualifyGitRegression(
        optionsFor({ root, before, after, neutral: after }, ".assertledger/invalid-source"),
      ),
      /GIT_WORLD_OVERLAY_UNSUPPORTED_INVALID_UTF8/,
    );
  });

  it("reserves one output for concurrent cooperating runs and publishes the manifest last", async () => {
    const concurrent = await fixture();
    const results = await Promise.allSettled([
      qualifyGitRegression(optionsFor(concurrent, ".assertledger/concurrent")),
      qualifyGitRegression(optionsFor(concurrent, ".assertledger/concurrent")),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected?.status, "rejected");
    if (rejected?.status === "rejected")
      assert.match(String(rejected.reason), /GIT_REGRESSION_OUTPUT_EXISTS/);
    const output = path.join(concurrent.root, ".assertledger", "concurrent");
    assert.equal((await stat(path.join(output, "executed-request.json"))).isFile(), true);
    assert.equal((await stat(path.join(output, "summary.md"))).isFile(), true);
    assert.equal((await stat(path.join(output, "manifest.json"))).isFile(), true);
  });

  it("cleans only files it owns when publication fails after reservation", async () => {
    const interrupted = await fixture();
    const output = path.join(interrupted.root, ".assertledger", "interrupted");
    const foreignSummary = "foreign concurrent content\n";
    const interfere = async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          if ((await stat(output)).isDirectory()) {
            await writeFile(path.join(output, "summary.md"), foreignSummary, { flag: "wx" });
            return;
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "EEXIST") throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("TEST_OUTPUT_RESERVATION_NOT_OBSERVED");
    };
    const qualification = qualifyGitRegression(
      optionsFor(interrupted, ".assertledger/interrupted"),
    );
    await interfere();
    await assert.rejects(qualification, /EEXIST/);
    assert.equal(await readFile(path.join(output, "summary.md"), "utf8"), foreignSummary);
    await assert.rejects(stat(path.join(output, "executed-request.json")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(output, "manifest.json")), { code: "ENOENT" });
  });

  it("requires the CLI unsafe flag before parsing or executing Git input", async () => {
    let stderr = "";
    const code = await runCli(["check", ".", "--json"], {
      cwd: process.cwd(),
      readStdin: async () => "",
      writeStdout: () => undefined,
      writeStderr: (text) => {
        stderr += text;
      },
    });
    assert.equal(code, 4);
    assert.match(stderr, /--allow-unsafe-execution/);
  });
});
