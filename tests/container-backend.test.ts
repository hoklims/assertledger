import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEvidenceManifestV2 } from "../src/contracts/index.js";
import { runNodeTestRuntimePreflight } from "../src/engine/adapters/node-test-runtime.js";
import { readContainerResultArchiveForTesting } from "../src/engine/container.js";
import { verifyCampaign } from "../src/engine/index.js";
import { AssertLedger } from "../src/sdk/index.js";

const FAKE_RUNTIME = fileURLToPath(
  new URL("./support/fake-container-runtime.mjs", import.meta.url),
);
const DIGEST = "e".repeat(64);
const IMAGE = `registry.example:5000/team/node:24@sha256:${DIGEST}`;
const LIMITS = {
  memoryBytes: 1_073_741_824,
  cpuMillicores: 2_000,
  pids: 256,
  temporaryDirectoryBytes: 67_108_864,
};
const HOST_SECRET = `host-secret-${randomUUID()}`;
const LONG_PATH = `src/${"nested-directory/".repeat(8)}données.js`;
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

async function fixture(scenario: Record<string, unknown> = {}) {
  const root = await temporaryDirectory("assertledger-container-repository-");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(root, "src", "value.js"), "export const value = 1;\n");
  const state = await temporaryDirectory("assertledger-fake-runtime-");
  await writeFile(path.join(state, "scenario.json"), JSON.stringify(scenario));
  return { root, state, command: [process.execPath, FAKE_RUNTIME, state] };
}

async function calls(state: string): Promise<string[][]> {
  let text: string;
  try {
    text = await readFile(path.join(state, "calls.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

function request(root: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "2.0.0",
    repository: { root, exclude: [] },
    adapter: {
      kind: "testforge-command",
      executable: "fake-adapter",
      arguments: ["--run"],
      protocolVersion: "1.0.0",
    },
    isolation: {
      kind: "container",
      image: IMAGE,
      environment: [{ name: "TZ", value: "UTC" }],
      limits: LIMITS,
    },
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
      timeoutMsPerExecution: 20_000,
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
        provenance: "fixture:fixed",
        files: [{ path: LONG_PATH, content: "export const nested = true;\n" }],
      },
      {
        id: "bug",
        kind: "TARGET",
        required: true,
        weight: 1,
        provenance: "fixture:bug",
        files: [{ path: "src/value.js", content: "// BUG\nexport const value = 0;\n" }],
      },
      {
        id: "neutral",
        kind: "NEUTRAL",
        required: true,
        weight: 0,
        provenance: "fixture:neutral",
        files: [{ path: "src/notes.txt", content: "neutral\n" }],
      },
    ],
    candidates: [
      { id: "candidate", files: [{ path: "tests/value.test.js", content: "// test\n" }] },
    ],
    ...overrides,
  };
}

function targetCandidateObservation(manifest: { observations: Array<Record<string, unknown>> }) {
  const observation = manifest.observations.find(
    (item) => item.candidateId === "candidate" && item.worldId === "bug",
  );
  assert.ok(observation);
  return observation;
}

describe("container backend selection", () => {
  it("stops before any execution when the runtime executable is absent", async () => {
    const value = await fixture();
    const missing = path.join(os.tmpdir(), `assertledger-missing-runtime-${randomUUID()}`);
    await assert.rejects(
      verifyCampaign(request(value.root), { containerRuntime: { command: [missing] } }),
      /CONTAINER_RUNTIME_NOT_FOUND/,
    );
  });

  it("stops with a diagnostic when the container daemon is unreachable", async () => {
    const value = await fixture({ version: "unavailable" });
    await assert.rejects(
      verifyCampaign(request(value.root), { containerRuntime: { command: value.command } }),
      /CONTAINER_RUNTIME_UNAVAILABLE/,
    );
    assert.deepEqual(
      (await calls(value.state)).map((call) => call[0]),
      ["version"],
    );
  });

  it("refuses a daemon or image that does not provide Linux containers", async () => {
    for (const [scenario, code] of [
      [{ serverOs: "windows" }, /CONTAINER_RUNTIME_PLATFORM_UNSUPPORTED/],
      [{ imageOs: "windows" }, /CONTAINER_IMAGE_PLATFORM_UNSUPPORTED/],
    ] as const) {
      const value = await fixture(scenario);
      await assert.rejects(
        verifyCampaign(request(value.root), { containerRuntime: { command: value.command } }),
        code,
      );
      assert.equal(
        (await calls(value.state)).some((call) => call[0] === "create"),
        false,
      );
    }
  });

  it("never pulls: an absent or differently identified image stops the campaign", async () => {
    for (const [scenario, code] of [
      [{ image: "missing" }, /CONTAINER_IMAGE_NOT_PRESENT/],
      [{ image: "mismatch" }, /CONTAINER_IMAGE_DIGEST_MISMATCH/],
    ] as const) {
      const value = await fixture(scenario);
      await assert.rejects(
        verifyCampaign(request(value.root), { containerRuntime: { command: value.command } }),
        code,
      );
      const verbs = (await calls(value.state)).map((call) => call[0]);
      assert.equal(verbs.includes("pull"), false);
      assert.equal(verbs.includes("create"), false);
      assert.equal(verbs.includes("run"), false);
    }
  });

  it("keeps v2 trusted-local execution behind explicit acknowledgement", async () => {
    const value = await fixture();
    await assert.rejects(
      verifyCampaign(
        request(value.root, {
          isolation: {
            kind: "trusted-local",
            acknowledgedUnsafeExecution: false,
            environmentAllowlist: [],
          },
        }),
        { containerRuntime: { command: value.command } },
      ),
      /UNSAFE_LOCAL_EXECUTION_NOT_ACKNOWLEDGED/,
    );
    assert.deepEqual(await calls(value.state), []);
  });
});

describe("container campaign execution", () => {
  it("runs every execution in a fresh hardened container and records the backend", async () => {
    const value = await fixture();
    process.env.ASSERTLEDGER_FAKE_HOST_SECRET = HOST_SECRET;
    let manifest: ReturnType<typeof parseEvidenceManifestV2>;
    try {
      manifest = parseEvidenceManifestV2(
        await verifyCampaign(request(value.root), {
          containerRuntime: { command: value.command },
        }),
      );
    } finally {
      delete process.env.ASSERTLEDGER_FAKE_HOST_SECRET;
    }
    assert.equal(manifest.decision.status, "VERIFIED");
    assert.deepEqual(manifest.isolation, {
      kind: "container",
      level: "CONTAINER",
      runtimeCommand: value.command,
    });
    assert.equal(manifest.evidenceContext.execution.isolation, "CONTAINER");
    assert.deepEqual(manifest.evidenceContext.execution.environmentAllowlist, ["TZ"]);
    assert.deepEqual(manifest.evidenceContext.execution.backend, {
      kind: "container",
      level: "CONTAINER",
      image: { reference: IMAGE, id: `sha256:${DIGEST}`, os: "linux", architecture: "amd64" },
      runtime: {
        clientVersion: "99.0.0-fake",
        serverVersion: "99.1.0-fake",
        serverOs: "linux",
        serverArchitecture: "amd64",
        cgroupVersion: "2",
        securityOptions: ["name=seccomp,profile=builtin", "name=no-new-privileges"],
      },
      controls: {
        network: "none",
        rootFilesystem: "read-only",
        hostMounts: "none",
        workspace: "anonymous-volume",
        user: "65534:65534",
        capabilities: "none",
        noNewPrivileges: true,
        imagePull: "never",
        logDriver: "none",
        environment: [{ name: "TZ", value: "UTC" }],
        limits: LIMITS,
      },
    });
    assert.ok(manifest.limitations.some((limitation) => /host kernel/u.test(limitation)));
    assert.equal(new AssertLedger().replay(manifest).valid, true);

    const recorded = await calls(value.state);
    assert.equal(
      recorded.some((call) => call.some((argument) => argument.includes(HOST_SECRET))),
      false,
    );
    const creates = recorded.filter((call) => call[0] === "create");
    assert.equal(creates.length, 6);
    const names = new Set<string>();
    for (const create of creates) {
      for (const flag of [
        "--pull=never",
        "--network=none",
        "--read-only",
        "--mount=type=volume,target=/assertledger",
        `--tmpfs=/tmp:rw,nosuid,nodev,size=${LIMITS.temporaryDirectoryBytes}`,
        "--user=65534:65534",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        `--pids-limit=${LIMITS.pids}`,
        `--memory=${LIMITS.memoryBytes}`,
        `--memory-swap=${LIMITS.memoryBytes}`,
        "--cpus=2",
        "--log-driver=none",
        "--workdir=/assertledger/repository",
        "--env=TZ=UTC",
        "--env=TESTFORGE_RESULT_FILE=/assertledger/out/result.json",
        "--entrypoint=fake-adapter",
      ]) {
        assert.ok(create.includes(flag), `${flag} missing from ${JSON.stringify(create)}`);
      }
      const imageIndex = create.indexOf(IMAGE);
      assert.ok(imageIndex > 0);
      assert.deepEqual(create.slice(imageIndex + 1), ["--run"]);
      for (const argument of create.slice(0, imageIndex)) {
        assert.doesNotMatch(
          argument,
          /^(?:(?:-v|--volume|--volumes-from|--privileged|--cap-add|--device|--pid|--ipc|--userns|--uts|--cgroupns)(?:=|$)|--network=(?!none$))|type=bind|^--env=(?!TZ=|TESTFORGE_)/u,
        );
      }
      const name = create.find((argument) => argument.startsWith("--name="))?.slice(7);
      assert.ok(name);
      names.add(name);
      const upload = JSON.parse(
        await readFile(path.join(value.state, "containers", name, "upload.json"), "utf8"),
      ) as Array<{ name: string; type: string; uid: number; gid: number }>;
      for (const entry of upload) {
        assert.ok(entry.type === "0" || entry.type === "5", JSON.stringify(entry));
        assert.equal(entry.name.startsWith("/") || entry.name.split("/").includes(".."), false);
        if (entry.name.startsWith("repository") || entry.name.startsWith("out")) {
          assert.deepEqual([entry.uid, entry.gid], [65534, 65534]);
        }
      }
      assert.ok(upload.some((entry) => entry.name === "repository/src/value.js"));
    }
    assert.equal(names.size, 6);
    const removed = recorded.filter((call) => call[0] === "rm");
    assert.deepEqual(new Set(removed.map((call) => call.at(-1))), names);
    for (const call of removed) assert.deepEqual(call.slice(0, 3), ["rm", "--force", "--volumes"]);
    const fixedUploads = await readdir(path.join(value.state, "containers"));
    assert.equal(fixedUploads.length, 6);
    assert.ok(
      await Promise.any(
        fixedUploads.map(async (name) => {
          const upload = JSON.parse(
            await readFile(path.join(value.state, "containers", name, "upload.json"), "utf8"),
          ) as Array<{ name: string }>;
          if (!upload.some((entry) => entry.name === `repository/${LONG_PATH}`)) {
            throw new Error("long path absent");
          }
          return true;
        }),
      ),
    );
  });

  it("never follows or accepts a result the candidate replaced by a link", async () => {
    const value = await fixture({ symlinkTargetResult: true });
    const manifest = parseEvidenceManifestV2(
      await verifyCampaign(request(value.root), { containerRuntime: { command: value.command } }),
    );
    const observation = targetCandidateObservation(manifest);
    assert.equal(observation.outcome, "INFRA_ERROR");
    assert.equal(observation.attributed, false);
    assert.notEqual(manifest.decision.status, "VERIFIED");
  });

  it("rejects result archive entries that escape the result path", async () => {
    const value = await fixture({ renamedResult: true });
    const manifest = parseEvidenceManifestV2(
      await verifyCampaign(request(value.root), { containerRuntime: { command: value.command } }),
    );
    assert.ok(manifest.observations.every((observation) => observation.outcome === "INFRA_ERROR"));
    assert.equal(manifest.decision.status, "INCONCLUSIVE");
  });

  it("kills and removes a container that exceeds its execution timeout", async () => {
    const value = await fixture({ hangTarget: true });
    const base = request(value.root);
    const started = Date.now();
    const manifest = parseEvidenceManifestV2(
      await verifyCampaign(
        { ...base, budgets: { ...base.budgets, timeoutMsPerExecution: 3_000 } },
        { containerRuntime: { command: value.command } },
      ),
    );
    assert.ok(Date.now() - started < 60_000);
    const observation = targetCandidateObservation(manifest);
    assert.equal(observation.outcome, "TIMEOUT");
    assert.equal(observation.attributed, false);
    assert.notEqual(manifest.decision.status, "VERIFIED");
    const recorded = await calls(value.state);
    const killed = recorded.filter((call) => call[0] === "kill").map((call) => call.at(-1));
    assert.equal(killed.length, 1);
    assert.ok(recorded.some((call) => call[0] === "rm" && call.at(-1) === killed[0]));
  });

  it("fails the campaign when a container cannot be removed", async () => {
    const value = await fixture({ rm: "fail" });
    await assert.rejects(
      verifyCampaign(request(value.root), { containerRuntime: { command: value.command } }),
      /CONTAINER_CLEANUP_FAILED/,
    );
  });

  it("runs node:test preflight probes through the container executor, never on the host", async () => {
    const probes: string[] = [];
    let hostExecutions = 0;
    let failure: unknown;
    const preflight = await runNodeTestRuntimePreflight({
      executable: "/usr/local/bin/node",
      reporterSource: "export default async function* reporter() {}\n",
      environment: {},
      timeoutMs: 20_000,
      maximumOutputBytes: 65_536,
      processRunner: async () => {
        hostExecutions += 1;
        return { outcome: "INFRA_ERROR", exitCode: null };
      },
      probeExecutor: async (probe) => {
        probes.push(probe.name);
        return {
          processResult: { outcome: "PROCESS_CRASH", exitCode: 1 },
          report: {
            protocolVersion: "1.0.0",
            testsDiscovered: 2,
            candidateTestsDiscovered: 1,
            candidateFailureCount: 1,
            nonCandidateFailureCount: 0,
            candidateSyntaxFailureCount: 0,
            candidateFailuresAllAssertions: probe.name === "assertion",
          },
        };
      },
    }).catch((error: unknown) => {
      failure = error;
      return undefined;
    });
    assert.equal(hostExecutions, 0);
    assert.deepEqual(probes, ["assertion", "generic-throw"]);
    assert.equal(failure, undefined);
    assert.equal(preflight?.assertionProbe.outcome, "ASSERTION_FAILURE");
    assert.equal(preflight?.genericThrowProbe.outcome, "PROCESS_CRASH");
  });
});

describe("container result archive reader", () => {
  function entry(name: string, type: string, content = "", linkName = ""): Buffer {
    const data = Buffer.from(content, "utf8");
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(type, 156, 1, "ascii");
    header.write(linkName, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512, 0)]);
  }
  const end = Buffer.alloc(1_024, 0);

  it("accepts exactly one bounded regular result file", () => {
    const archive = Buffer.concat([entry("result.json", "0", '{"ok":true}'), end]);
    assert.equal(
      readContainerResultArchiveForTesting(archive, 64)?.toString("utf8"),
      '{"ok":true}',
    );
  });

  it("rejects links, extra entries, escaping names, oversize data and corrupt headers", () => {
    const corrupt = Buffer.concat([entry("result.json", "0", "{}"), end]);
    corrupt[140] = "7".charCodeAt(0);
    for (const archive of [
      Buffer.concat([entry("result.json", "2", "", "/etc/passwd"), end]),
      Buffer.concat([entry("result.json", "1", "", "result-other.json"), end]),
      Buffer.concat([entry("result.json", "0", "{}"), entry("result.json", "0", "{}"), end]),
      Buffer.concat([entry("../result.json", "0", "{}"), end]),
      Buffer.concat([entry("out/result.json", "0", "{}"), end]),
      Buffer.concat([entry("result.json", "0", "x".repeat(65)), end]),
      corrupt,
      entry("result.json", "0", "{}").subarray(0, 600),
    ]) {
      assert.equal(readContainerResultArchiveForTesting(archive, 64), undefined);
    }
  });
});
