import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.js";
import { parseEvidenceManifestV2 } from "../src/contracts/index.js";
import { runProcess, verifyCampaign } from "../src/engine/index.js";

// Hostile scenarios against a real Docker Engine. They need an operator-provided runtime argv and a
// locally present digest-pinned Node.js image, never pull, and fail instead of skipping when
// ASSERTLEDGER_REQUIRE_CONTAINER_TESTS=1.
const runtimeSetting = process.env.ASSERTLEDGER_CONTAINER_RUNTIME ?? "";
const image = process.env.ASSERTLEDGER_CONTAINER_IMAGE ?? "";
const required = process.env.ASSERTLEDGER_REQUIRE_CONTAINER_TESTS === "1";
const configured = runtimeSetting.length > 0 && image.length > 0;
const runtime = configured ? (JSON.parse(runtimeSetting) as string[]) : [];
const skip =
  configured || required
    ? false
    : "set ASSERTLEDGER_CONTAINER_RUNTIME (JSON argv) and ASSERTLEDGER_CONTAINER_IMAGE to run";
const PROBE = fileURLToPath(new URL("./support/container-hostile-probe.mjs", import.meta.url));
const LIMITS = {
  memoryBytes: 268_435_456,
  cpuMillicores: 1_000,
  pids: 64,
  temporaryDirectoryBytes: 16_777_216,
};
const temporaryDirectories: string[] = [];

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
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function runtimeOutput(args: string[]): Promise<string> {
  const [executable, ...prefix] = runtime;
  const result = await runProcess({
    executable: executable as string,
    args: [...prefix, ...args],
    cwd: os.tmpdir(),
    environment: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    timeoutMs: 60_000,
    maximumOutputBytes: 1_048_576,
  });
  assert.equal(result.outcome, "PASS", result.stderr.text);
  return result.stdout.text;
}

function lines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function danglingVolumes(): Promise<string[]> {
  return lines(await runtimeOutput(["volume", "ls", "--quiet", "--filter", "dangling=true"]));
}

/** Every execution container and its anonymous workspace volume must be gone after a campaign. */
async function assertCleanedUp(volumesBefore: readonly string[]): Promise<void> {
  const containers = lines(
    await runtimeOutput([
      "ps",
      "--all",
      "--filter",
      "label=assertledger.execution",
      "--format",
      "{{.Names}}",
    ]),
  );
  assert.deepEqual(containers, []);
  const known = new Set(volumesBefore);
  assert.deepEqual(
    (await danglingVolumes()).filter((volume) => !known.has(volume)),
    [],
  );
}

async function probeRepository(worlds: { fixed?: string; bug: string; neutral: string }) {
  const root = await temporaryDirectory("assertledger-docker-repository-");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(root, "src", "value.js"), "export const value = 1;\n");
  await copyFile(PROBE, path.join(root, "probe.mjs"));
  return (environment: Array<{ name: string; value: string }>, timeoutMsPerExecution: number) => ({
    schemaVersion: "2.0.0",
    repository: { root, exclude: [] },
    adapter: {
      kind: "testforge-command",
      executable: "node",
      arguments: ["probe.mjs"],
      protocolVersion: "1.0.0",
    },
    isolation: { kind: "container", image, environment, limits: LIMITS },
    candidateRoots: ["tests"],
    budgets: {
      maximumCandidates: 1,
      maximumWorlds: 3,
      maximumExecutions: 6,
      maximumRepositoryFiles: 100,
      maximumRepositoryBytes: 1_000_000,
      maximumWorldOverlayBytes: 100_000,
      maximumCandidateBytes: 10_000,
      maximumTotalCandidateBytes: 10_000,
      timeoutMsPerExecution,
      maximumOutputBytes: 65_536,
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 1,
      minimumTargetWeightPermille: 1_000,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds: [
      {
        id: "fixed",
        kind: "REFERENCE",
        required: true,
        weight: 0,
        provenance: "f",
        files: worlds.fixed === undefined ? [] : [{ path: "src/value.js", content: worlds.fixed }],
      },
      {
        id: "bug",
        kind: "TARGET",
        required: true,
        weight: 1,
        provenance: "b",
        files: [{ path: "src/value.js", content: worlds.bug }],
      },
      {
        id: "neutral",
        kind: "NEUTRAL",
        required: true,
        weight: 0,
        provenance: "n",
        files: [{ path: "src/value.js", content: worlds.neutral }],
      },
    ],
    candidates: [
      { id: "candidate", files: [{ path: "tests/value.test.js", content: "// test\n" }] },
    ],
  });
}

function outcomes(manifest: { observations: Array<Record<string, unknown>> }): string[] {
  return manifest.observations
    .map((item) => `${item.runId}:${item.outcome}:${item.attributed}:${item.exitCode}`)
    .sort();
}

describe("real container isolation", { skip, concurrency: false }, () => {
  it("has a configured runtime and image when container tests are required", () => {
    assert.ok(configured, "ASSERTLEDGER_CONTAINER_RUNTIME and ASSERTLEDGER_CONTAINER_IMAGE");
  });

  it("contains network, root file system, host paths, environment, privileges, temporary storage and processes", async () => {
    const volumesBefore = await danglingVolumes();
    const request = await probeRepository({
      fixed: "// SCENARIO:contained\nexport const value = 1;\n",
      bug: "// SCENARIO:detected\nexport const value = 0;\n",
      neutral: "// SCENARIO:contained\nexport const value = 2 - 1;\n",
    });
    const hostDirectory = await temporaryDirectory("assertledger-docker-canary-");
    const canary = path.join(hostDirectory, "canary.txt");
    await writeFile(canary, "host canary\n");
    const imageEnvironment = JSON.parse(
      await runtimeOutput(["image", "inspect", "--format={{json .Config.Env}}", image]),
    ) as string[];
    const declared = [
      { name: "HOST_CANARY_PATH", value: canary },
      { name: "TZ", value: "UTC" },
    ];
    const expectedEnvironment = [
      ...imageEnvironment.map((entry) => entry.slice(0, entry.indexOf("="))),
      "HOME",
      "HOSTNAME",
      "ASSERTLEDGER_EXPECTED_ENVIRONMENT",
      ...declared.map((variable) => variable.name),
      "TESTFORGE_CANDIDATE_FILES",
      "TESTFORGE_RESULT_FILE",
    ];
    process.env.ASSERTLEDGER_DOCKER_HOST_SECRET = "must-not-enter-the-container";
    let manifest: ReturnType<typeof parseEvidenceManifestV2>;
    try {
      manifest = parseEvidenceManifestV2(
        await verifyCampaign(
          request(
            [
              ...declared,
              {
                name: "ASSERTLEDGER_EXPECTED_ENVIRONMENT",
                value: JSON.stringify(expectedEnvironment),
              },
            ],
            60_000,
          ),
          { containerRuntime: { command: runtime } },
        ),
      );
    } finally {
      delete process.env.ASSERTLEDGER_DOCKER_HOST_SECRET;
    }
    assert.deepEqual(outcomes(manifest), [
      "candidate:bug:1:ASSERTION_FAILURE:true:1",
      "candidate:fixed:1:PASS:true:0",
      "candidate:neutral:1:PASS:true:0",
      "control:bug:1:PASS:false:0",
      "control:fixed:1:PASS:false:0",
      "control:neutral:1:PASS:false:0",
    ]);
    assert.equal(manifest.decision.status, "VERIFIED");
    assert.equal(manifest.evidenceContext.execution.backend.kind, "container");
    assert.equal(await readFile(canary, "utf8"), "host canary\n");
    assert.deepEqual(await readdir(hostDirectory), ["canary.txt"]);
    await assertCleanedUp(volumesBefore);
  });

  it("times out detached descendants and never follows a result link", async () => {
    const volumesBefore = await danglingVolumes();
    const request = await probeRepository({
      bug: "// SCENARIO:hang\nexport const value = 0;\n",
      neutral: "// SCENARIO:link\nexport const value = 1;\n",
    });
    const manifest = parseEvidenceManifestV2(
      await verifyCampaign(request([], 5_000), { containerRuntime: { command: runtime } }),
    );
    assert.deepEqual(outcomes(manifest), [
      "candidate:bug:1:TIMEOUT:false:null",
      "candidate:fixed:1:PASS:true:0",
      "candidate:neutral:1:INFRA_ERROR:false:0",
      "control:bug:1:PASS:false:0",
      "control:fixed:1:PASS:false:0",
      "control:neutral:1:PASS:false:0",
    ]);
    assert.notEqual(manifest.decision.status, "VERIFIED");
    await assertCleanedUp(volumesBefore);
  });

  it("stops a process that exceeds the memory limit without counting it as a kill", async () => {
    const volumesBefore = await danglingVolumes();
    const request = await probeRepository({
      bug: "// SCENARIO:memory\nexport const value = 0;\n",
      neutral: "export const value = 2 - 1;\n",
    });
    const manifest = parseEvidenceManifestV2(
      await verifyCampaign(request([], 60_000), { containerRuntime: { command: runtime } }),
    );
    const target = manifest.observations.find((item) => item.runId === "candidate:bug:1");
    assert.ok(target);
    assert.equal(target.outcome, "INFRA_ERROR");
    assert.equal(target.attributed, false);
    assert.equal(target.exitCode, 137);
    assert.notEqual(manifest.decision.status, "VERIFIED");
    await assertCleanedUp(volumesBefore);
  });

  it("never pulls an image that is not present locally", async () => {
    const request = await probeRepository({ bug: "// SCENARIO:detected\n", neutral: "// n\n" });
    const value = request([], 5_000);
    await assert.rejects(
      verifyCampaign(
        {
          ...value,
          isolation: {
            ...value.isolation,
            image: `assertledger.invalid/absent/node@sha256:${"0".repeat(64)}`,
          },
        },
        { containerRuntime: { command: runtime } },
      ),
      /CONTAINER_IMAGE_NOT_PRESENT/,
    );
  });

  it("qualifies a committed node:test regression end to end through the CLI", async () => {
    const volumesBefore = await danglingVolumes();
    const root = await temporaryDirectory("assertledger-docker-git-");
    const git = async (args: string[]) => {
      const result = await runProcess({
        executable: "git",
        args,
        cwd: root,
        environment: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
        timeoutMs: 10_000,
        maximumOutputBytes: 65_536,
      });
      assert.equal(result.outcome, "PASS", result.stderr.text);
      return result.stdout.text.trim();
    };
    const commit = async (message: string) => {
      await git(["add", "."]);
      await git([
        "-c",
        "user.name=AssertLedger Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        message,
      ]);
      return git(["rev-parse", "HEAD"]);
    };
    await git(["init"]);
    await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
    await writeFile(path.join(root, "subject.js"), "export const total = () => 1;\n");
    await writeFile(
      path.join(root, "base.test.js"),
      'import test from "node:test"; import assert from "node:assert/strict"; test("base",()=>assert.equal(1,1));\n',
    );
    const before = await commit("bug");
    await writeFile(path.join(root, "subject.js"), "export const total = () => 2;\n");
    await commit("fix");
    await writeFile(
      path.join(root, "candidate.test.js"),
      'import test from "node:test"; import assert from "node:assert/strict"; import { total } from "./subject.js"; test("regression",()=>assert.equal(total(),2));\n',
    );
    const after = await commit("candidate");
    let stdout = "";
    let stderr = "";
    const io = {
      cwd: root,
      readStdin: async () => "",
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: (text: string) => {
        stderr += text;
      },
    };
    const code = await runCli(
      [
        "check",
        root,
        "--before",
        before,
        "--after",
        after,
        "--neutral",
        after,
        "--neutral-reason",
        "explicit repeated control",
        "--test",
        "candidate.test.js",
        "--base-test",
        "base.test.js",
        "--out",
        ".assertledger/evidence",
        "--container-image",
        image,
        "--container-runtime",
        JSON.stringify(runtime),
      ],
      io,
    );
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.match(stdout, /\*\*CONTAINER\*\* isolation/u);
    const manifestPath = path.join(root, ".assertledger", "evidence", "manifest.json");
    const manifest = parseEvidenceManifestV2(JSON.parse(await readFile(manifestPath, "utf8")));
    assert.equal(manifest.decision.status, "VERIFIED");
    assert.equal(manifest.evidenceContext.execution.backend.kind, "container");
    assert.equal(await runCli(["replay", manifestPath], io), 0, stderr);
    await assertCleanedUp(volumesBefore);
  });
});
