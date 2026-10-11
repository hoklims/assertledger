import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  type BoundedProcessResult,
  type ContainerBackend,
  type ContainerProcessRunner,
  runContainerExecution,
} from "../src/engine/container.js";

it("uploads a compressed archive retaining the exact workspace and read-only adapter assets", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "assertledger-upload-"));
  const content = "repository bytes remain unchanged\n".repeat(8192);
  const output = { text: "", totalBytes: 0, truncated: false, digest: `sha256:${"0".repeat(64)}` };
  const result: BoundedProcessResult = {
    outcome: "PASS",
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 1,
    stdout: output,
    stderr: output,
    stdoutBytes: Buffer.alloc(0),
  };
  let uploaded = Buffer.alloc(0);
  const runner: ContainerProcessRunner = async (input, stdin) => {
    if (stdin) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stdin) chunks.push(chunk);
      uploaded = Buffer.concat(chunks);
    }
    return input.args[0] === "inspect"
      ? {
          ...result,
          stdoutBytes: Buffer.from(
            JSON.stringify({
              Status: "exited",
              ExitCode: 0,
              Error: "",
              StartedAt: "2026-10-11T00:00:00Z",
            }),
          ),
        }
      : result;
  };
  const backend: ContainerBackend = {
    runtimeCommand: ["runtime"],
    record: {} as ContainerBackend["record"],
    isolation: {
      kind: "container",
      image: `image@sha256:${"e".repeat(64)}`,
      environment: [],
      limits: {
        memoryBytes: 1_073_741_824,
        cpuMillicores: 2000,
        pids: 256,
        temporaryDirectoryBytes: 67_108_864,
      },
    },
  };
  try {
    await writeFile(path.join(workspace, "fixture.txt"), content);
    await runContainerExecution(
      backend,
      {
        workspace,
        assets: [{ name: "driver.mjs", content: "read-only adapter" }],
        executable: "bun",
        args: [],
        environment: {},
        timeoutMs: 1000,
        maximumOutputBytes: 1000,
      },
      runner,
      workspace,
    );
    assert.deepEqual(
      [...uploaded.subarray(0, 2)],
      [0x1f, 0x8b],
      "upload must be gzip rather than an uncompressed tar stream",
    );
    assert.ok(uploaded.byteLength < Buffer.byteLength(content) / 4);
    const archive = gunzipSync(uploaded);
    assert.ok(archive.includes(Buffer.from(content)));
    assert.ok(archive.includes(Buffer.from("read-only adapter")));
    assert.ok(archive.includes(Buffer.from("repository/fixture.txt")));
    assert.ok(archive.includes(Buffer.from("reporter/driver.mjs")));
    const header = archive.subarray(archive.indexOf(Buffer.from("reporter/driver.mjs")));
    assert.match(header.subarray(100, 108).toString("ascii"), /444/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
