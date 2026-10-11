import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ContainerBackend } from "../src/engine/container.js";
import { buildDockerCreateRequest, openDockerStdioControl } from "../src/engine/docker-stdio.js";

const create = [
  "create",
  "--pull=never",
  "--name=assertledger-test",
  "--label=assertledger.execution=assertledger-test",
  "--network=none",
  "--read-only",
  "--mount=type=volume,target=/assertledger",
  "--tmpfs=/tmp:rw,nosuid,nodev,size=67108864",
  "--user=65534:65534",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--pids-limit=256",
  "--memory=1073741824",
  "--memory-swap=1073741824",
  "--cpus=2.000",
  "--log-driver=none",
  "--workdir=/assertledger/repository",
  "--env=KEY=value=with=equals",
  "--entrypoint=bun",
  `oven/bun@sha256:${"e".repeat(64)}`,
  "test",
  "--file",
  "test.ts",
];

test("create translation preserves isolation, limits, argv and environment", () => {
  assert.deepEqual(buildDockerCreateRequest(create), {
    Image: `oven/bun@sha256:${"e".repeat(64)}`,
    Entrypoint: ["bun"],
    Cmd: ["test", "--file", "test.ts"],
    Env: ["KEY=value=with=equals"],
    AttachStdout: true,
    AttachStderr: true,
    User: "65534:65534",
    WorkingDir: "/assertledger/repository",
    Labels: { "assertledger.execution": "assertledger-test" },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Mounts: [{ Type: "volume", Target: "/assertledger" }],
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=67108864" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      PidsLimit: 256,
      Memory: 1073741824,
      MemorySwap: 1073741824,
      NanoCpus: 2000000000,
      LogConfig: { Type: "none" },
    },
  });
});

const fake = fileURLToPath(new URL("./support/fake-docker-stdio.mjs", import.meta.url));
const expected = {
  image: {
    reference: `oven/bun@sha256:${"e".repeat(64)}`,
    id: `sha256:${"e".repeat(64)}`,
    os: "linux",
    architecture: "amd64",
  },
  runtime: {
    serverVersion: "29.7.2",
    serverOs: "linux",
    serverArchitecture: "amd64",
    cgroupVersion: "2",
    securityOptions: ["seccomp", "cgroupns"],
  },
} as ContainerBackend["record"];

async function fixture(scenario: Record<string, unknown> = {}) {
  const state = await mkdtemp(path.join(os.tmpdir(), "assertledger-docker-stdio-"));
  await writeFile(path.join(state, "scenario.json"), JSON.stringify(scenario));
  const command = [process.execPath, fake, state];
  const input = (args: string[], maximumOutputBytes = 4096, timeoutMs = 3000) => ({
    executable: process.execPath,
    args: [fake, state, ...args],
    cwd: state,
    environment: {},
    maximumOutputBytes,
    timeoutMs,
  });
  const lines = async (file: string) =>
    (await readFile(path.join(state, file), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return {
    state,
    command,
    input,
    lines,
    dispose: () => rm(state, { recursive: true, force: true }),
  };
}

test("only one control subprocess serves handshake, creation, streamed upload, inspection and cleanup", async () => {
  const f = await fixture();
  const control = await openDockerStdioControl(f.command, f.state, expected);
  try {
    assert.equal((await control.run(f.input(create))).outcome, "PASS");
    const archive = Buffer.alloc(65536, 42);
    async function* stream() {
      for (let i = 0; i < archive.length; i += 1024) yield archive.subarray(i, i + 1024);
    }
    assert.equal(
      (
        await control.run(
          f.input(["cp", "--archive", "-", "assertledger-test:/assertledger"]),
          stream(),
        )
      ).outcome,
      "PASS",
    );
    const inspection = await control.run(
      f.input(["inspect", "--type=container", "--format={{json .State}}", "assertledger-test"]),
    );
    assert.equal(JSON.parse(inspection.stdout.text).ExitCode, 0);
    assert.equal(
      (
        await control.run(f.input(["cp", "assertledger-test:/assertledger/out/result.json", "-"]))
      ).stdoutBytes.toString(),
      "aaaaaaaa",
    );
    assert.equal((await control.run(f.input(["kill", "assertledger-test"]))).outcome, "PASS");
    assert.equal(
      (await control.run(f.input(["rm", "--force", "--volumes", "assertledger-test"]))).outcome,
      "PASS",
    );
    assert.deepEqual(await f.lines("launches.jsonl"), [["system", "dial-stdio"]]);
    const requests = await f.lines("requests.jsonl");
    assert.equal(requests.length, 9);
    assert.equal(
      requests[4].url,
      "/v1.55/containers/assertledger-test/archive?path=%2Fassertledger&copyUIDGID=true&noOverwriteDirNonDir=true",
    );
    assert.deepEqual(Buffer.from(requests[4].body, "base64"), archive);
    assert.deepEqual(
      JSON.parse(Buffer.from(requests[3].body, "base64").toString()),
      buildDockerCreateRequest(create),
    );
    assert.equal(control.alive, true);
  } finally {
    await control.close();
    await f.dispose();
  }
  assert.equal(control.alive, false);
});

test("qualification refuses incompatible API, daemon identity, image or security before mutations", async () => {
  for (const scenario of [
    { api: "1.40" },
    { version: "other" },
    { image: `sha256:${"f".repeat(64)}` },
    { security: [] },
  ]) {
    const f = await fixture(scenario);
    try {
      await assert.rejects(
        openDockerStdioControl(f.command, f.state, expected),
        /CONTAINER_STDIO_UNAVAILABLE/,
      );
      assert.ok((await f.lines("requests.jsonl")).every((entry) => entry.method === "GET"));
    } finally {
      await f.dispose();
    }
  }
});

test("API versions negotiate down and operator prefix mismatches never reach the daemon", async () => {
  const f = await fixture({ api: "1.44" });
  const control = await openDockerStdioControl(f.command, f.state, expected);
  try {
    const input = f.input(create);
    input.args[1] = "different-state";
    assert.equal((await control.run(input)).outcome, "INFRA_ERROR");
    assert.equal((await f.lines("requests.jsonl"))[1].url, "/v1.44/info");
    assert.equal((await f.lines("requests.jsonl")).length, 3);
  } finally {
    await control.close();
    await f.dispose();
  }
});

test("oversized, truncated and error responses fail boundedly without target attribution", async () => {
  for (const scenario of [{ large: true }, { truncated: true }, { httpError: true }]) {
    const f = await fixture(scenario);
    const control = await openDockerStdioControl(f.command, f.state, expected);
    try {
      const output = await control.run(
        f.input(["cp", "assertledger-test:/assertledger/out/result.json", "-"], 1024),
      );
      assert.equal(output.outcome, "INFRA_ERROR");
      assert.equal(output.exitCode, null);
      assert.ok(output.stdoutBytes.length <= 1024);
      assert.equal(control.alive, false);
    } finally {
      await control.close();
      await f.dispose();
    }
  }
});

test("lost create response poisons the session and never retries the ambiguous mutation", async () => {
  const f = await fixture({ loseCreate: true });
  const control = await openDockerStdioControl(f.command, f.state, expected);
  try {
    assert.equal((await control.run(f.input(create))).outcome, "INFRA_ERROR");
    assert.equal((await control.run(f.input(create))).outcome, "INFRA_ERROR");
    assert.equal(
      (await f.lines("requests.jsonl")).filter((entry) => entry.method === "POST").length,
      1,
    );
    assert.equal((await f.lines("launches.jsonl")).length, 1);
  } finally {
    await control.close();
    await f.dispose();
  }
});

test("state output retains its bound when valid command metadata exceeds that bound", async () => {
  const f = await fixture({ inspectMetadata: 5000 });
  const control = await openDockerStdioControl(f.command, f.state, expected);
  try {
    assert.equal((await control.run(f.input([...create, "x".repeat(5000)]))).outcome, "PASS");
    const inspection = await control.run(
      f.input(
        ["inspect", "--type=container", "--format={{json .State}}", "assertledger-test"],
        1024,
      ),
    );
    assert.equal(
      inspection.outcome,
      "PASS",
      "valid Config metadata must not consume the State output budget",
    );
    assert.ok(inspection.stdoutBytes.length <= 1024);
    assert.equal(JSON.parse(inspection.stdout.text).Status, "exited");
  } finally {
    await control.close();
    await f.dispose();
  }
});

test("missing container removal is not accepted as successful cleanup", async () => {
  const f = await fixture({ removeMissing: true });
  const control = await openDockerStdioControl(f.command, f.state, expected);
  try {
    const removal = await control.run(f.input(["rm", "--force", "--volumes", "assertledger-test"]));
    assert.equal(removal.outcome, "INFRA_ERROR");
    assert.equal(control.alive, false);
  } finally {
    await control.close();
    await f.dispose();
  }
});

test("an early success response cannot hide a later upload producer failure", async () => {
  const f = await fixture({ earlyUploadResponse: true });
  const control = await openDockerStdioControl(f.command, f.state, expected);
  try {
    async function* source() {
      yield Buffer.from("partial archive");
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new Error("input producer failed");
    }
    const output = await control.run(
      f.input(["cp", "--archive", "-", "assertledger-test:/assertledger"]),
      source(),
    );
    assert.equal(
      output.outcome,
      "INFRA_ERROR",
      "HTTP success must wait for complete input delivery",
    );
    assert.equal(control.alive, false);
  } finally {
    await control.close();
    await f.dispose();
  }
});

test("hung upload respects its original deadline, fails as infrastructure and closes", async () => {
  const f = await fixture({ hangUpload: true });
  const control = await openDockerStdioControl(f.command, f.state, expected);
  try {
    async function* source() {
      yield Buffer.from("archive");
    }
    const output = await control.run(
      f.input(["cp", "--archive", "-", "assertledger-test:/assertledger"], 4096, 100),
      source(),
    );
    assert.equal(output.outcome, "INFRA_ERROR");
    assert.ok(output.durationMs < 1500);
    assert.equal(control.alive, false);
  } finally {
    await control.close();
    await f.dispose();
  }
});

test("create rejects unknown or weakened flags and never sets a shared named volume", () => {
  for (const replacement of [
    "--network=host",
    "--mount=type=volume,source=shared,target=/assertledger",
    "--pull=always",
    "--privileged",
  ]) {
    const args = [...create];
    const key = replacement.split("=")[0];
    const index = args.findIndex((arg) => arg.split("=")[0] === key);
    if (index >= 0) args[index] = replacement;
    else args.splice(1, 0, replacement);
    assert.throws(() => buildDockerCreateRequest(args), /CONTAINER_STDIO_UNAVAILABLE/);
  }
});

test("CPU translation accepts the existing CLI's integer and fractional millicore formatting", () => {
  for (const [cpus, nanoCpus] of [
    ["2", 2000000000],
    ["0.125", 125000000],
    ["1.05", 1050000000],
  ] as const) {
    const args = create.map((arg) => (arg.startsWith("--cpus=") ? `--cpus=${cpus}` : arg));
    const payload = buildDockerCreateRequest(args);
    assert.equal((payload.HostConfig as Record<string, unknown>).NanoCpus, nanoCpus);
  }
});

test("oversized headers and subprocess stderr are bounded during capability qualification", async () => {
  for (const scenario of [{ largeHeaders: true }, { stderrFlood: true }]) {
    const f = await fixture(scenario);
    try {
      await assert.rejects(
        openDockerStdioControl(f.command, f.state, expected),
        /CONTAINER_STDIO_UNAVAILABLE/,
      );
    } finally {
      await f.dispose();
    }
  }
});
