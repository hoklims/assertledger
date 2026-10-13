import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { type CliIo, runCli } from "../src/cli.js";
import { parseEvidenceManifestV4, parseWitnessImportRequest } from "../src/contracts/index.js";
import { replayEvidenceManifest } from "../src/core/index.js";
import { AssertLedger } from "../src/sdk/index.js";

const bun = process.env.ASSERTLEDGER_BUN_EXECUTABLE ?? "bun";
const temporaryDirectories: string[] = [];
const ENVIRONMENT = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

const BASE = 'export const names = () => ["a", "docs"];\n';
const digest = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

async function repository(): Promise<string> {
  const root = await temporaryDirectory("assertledger-witness-repository-");
  const files: Record<string, string> = {
    "package.json": '{"type":"module"}\n',
    "tools/gates.test.ts":
      'import { describe, expect, test } from "bun:test";\nimport { names } from "../src/names";\ndescribe("gate routing", () => {\n  test("keeps docs", () => { expect(names()).toContain("docs"); });\n});\n',
    "src/names.ts": BASE,
  };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  return root;
}

function witness(
  root: string,
  content = 'export const names = () => ["a"];\n',
  beforeDigest = digest(BASE),
) {
  return {
    schemaVersion: "1.0.0",
    provenance: "fixture witness 1",
    repository: { root, exclude: [], includeDependencies: false, git: "excluded" },
    adapter: { kind: "bun-test-designated", executable: bun, testTimeoutMs: null },
    test: { file: "tools/gates.test.ts", path: ["gate routing", "keeps docs"] },
    expectedFailure: "error: expect(received).toContain(expected)",
    targets: [{ path: "src/names.ts", beforeDigest, content }],
    neutral: null,
    requiredAttempts: 2,
    timeoutMsPerExecution: 60_000,
  };
}

const local = { kind: "trusted-local" as const, environmentAllowlist: ENVIRONMENT };

describe("witness import", () => {
  it("replays a recorded red/green pair to VERIFIED evidence that replays as valid", async () => {
    const root = await repository();
    const out = path.join(await temporaryDirectory("assertledger-witness-out-"), "evidence");
    const manifest = await new AssertLedger().importWitness(witness(root), {
      out,
      isolation: local,
    });
    assert.equal(manifest.decision.status, "VERIFIED");
    assert.equal(manifest.isolation.level, "UNSANDBOXED");
    assert.deepEqual((await readdir(out)).sort(), [
      "executed-request.json",
      "manifest.json",
      "summary.md",
    ]);
    const saved = parseEvidenceManifestV4(
      JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8")),
    );
    assert.equal(replayEvidenceManifest(saved).valid, true);
    assert.ok(
      saved.limitations.includes(
        "The neutral control repeats the reference snapshot and provides no independent robustness evidence.",
      ),
    );
    const summary = await readFile(path.join(out, "summary.md"), "utf8");
    assert.match(summary, /Verdict: \*\*VERIFIED\*\*/u);
    assert.match(summary, /Isolation: \*\*UNSANDBOXED\*\*/u);
  });

  it("never verifies a recorded mutant that breaks the import", async () => {
    const root = await repository();
    const out = path.join(await temporaryDirectory("assertledger-witness-out-"), "evidence");
    const manifest = await new AssertLedger().importWitness(
      witness(root, 'import "./missing";\nexport const names = () => ["a"];\n'),
      { out, isolation: local },
    );
    assert.notEqual(manifest.decision.status, "VERIFIED");
    assert.equal(
      manifest.observations.some((run) => run.outcome === "ASSERTION_FAILURE"),
      false,
    );
  });

  it("refuses a target whose bytes differ from the recorded base, and writes nothing", async () => {
    const root = await repository();
    const parent = await temporaryDirectory("assertledger-witness-out-");
    const out = path.join(parent, "evidence");
    await assert.rejects(
      new AssertLedger().importWitness(
        witness(root, BASE.replace("docs", "x"), digest("other\n")),
        {
          out,
          isolation: local,
        },
      ),
      (error: Error) =>
        error.message === "WITNESS_TARGET_BASE_MISMATCH" && error.cause === "src/names.ts",
    );
    await assert.rejects(stat(out), { code: "ENOENT" });
    await assert.rejects(
      new AssertLedger().importWitness(witness(root, BASE), { out, isolation: local }),
      /WITNESS_TARGET_UNCHANGED/u,
    );
  });

  it("writes only into a new directory outside the repository", async () => {
    const root = await repository();
    await assert.rejects(
      new AssertLedger().importWitness(witness(root), {
        out: path.join(root, "evidence"),
        isolation: local,
      }),
      /WITNESS_OUTPUT_INSIDE_REPOSITORY/u,
    );
    const existing = await temporaryDirectory("assertledger-witness-out-");
    await assert.rejects(
      new AssertLedger().importWitness(witness(root), { out: existing, isolation: local }),
      /WITNESS_OUTPUT_EXISTS/u,
    );
  });

  it("validates the request shape and refuses to run without an operator-chosen backend", async () => {
    const root = await repository();
    assert.throws(
      () => parseWitnessImportRequest({ ...witness(root), requiredAttempts: 1 }),
      /WITNESS_IMPORT_REQUEST_INVALID/u,
    );
    assert.throws(
      () =>
        parseWitnessImportRequest({
          ...witness(root),
          adapter: { kind: "bun-test-designated", executable: "bun", testTimeoutMs: 60_000 },
        }),
      /DESIGNATED_TEST_TIMEOUT_EXCEEDS_EXECUTION/u,
    );
    const parent = await temporaryDirectory("assertledger-witness-cli-");
    const requestFile = path.join(parent, "witness.json");
    await writeFile(requestFile, JSON.stringify(witness(root)));
    let stderr = "";
    const io: CliIo = {
      cwd: parent,
      readStdin: async () => "",
      writeStdout: () => undefined,
      writeStderr: (text) => {
        stderr += text;
      },
    };
    assert.equal(await runCli(["import-witness", requestFile, "--out", "evidence"], io), 4);
    assert.match(stderr, /without an authorized backend/u);
    await assert.rejects(stat(path.join(parent, "evidence")), { code: "ENOENT" });
  });
});

// Witness 28 of dofus_battlebot PR 327 at 484e85ae. ASSERTLEDGER_WITNESS_28_REQUEST names an
// import request whose repository is a git archive of that revision with its dependencies
// installed (bun install --frozen-lockfile --linker hoisted); see docs/witness-import.md.
const witness28 = process.env.ASSERTLEDGER_WITNESS_28_REQUEST ?? "";

describe("witness 28 of dofus_battlebot 484e85ae", {
  skip: witness28 === "" ? "set ASSERTLEDGER_WITNESS_28_REQUEST to run" : false,
}, () => {
  it("replays to VERIFIED evidence whose replay is valid", { timeout: 1_800_000 }, async () => {
    const out = path.join(await temporaryDirectory("assertledger-witness-28-"), "evidence");
    const request = JSON.parse(await readFile(witness28, "utf8")) as unknown;
    const manifest = await new AssertLedger().importWitness(request, {
      out,
      isolation: {
        kind: "trusted-local",
        environmentAllowlist: [...ENVIRONMENT, "HOME", "USERPROFILE", "LOCALAPPDATA"],
      },
    });
    assert.equal(manifest.decision.status, "VERIFIED", manifest.decision.reasonCodes.join(","));
    const saved = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8")) as unknown;
    assert.equal(replayEvidenceManifest(saved).valid, true);
  });
});
