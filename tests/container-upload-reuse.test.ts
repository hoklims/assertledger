import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

it("reuses only complete immutable upload bytes with matching input and asset identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-upload-reuse-"));
  const first = path.join(root, "first"),
    second = path.join(root, "second");
  await mkdir(first);
  await mkdir(second);
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
  const uploads: Buffer[] = [];
  const runner: ContainerProcessRunner = async (input, stdin) => {
    if (stdin) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stdin) chunks.push(chunk);
      uploads.push(Buffer.concat(chunks));
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
  const uploadArchives = {
    entries: new Map<string, { bytes: Buffer; digest: string; size: number }>(),
    bytes: 0,
    maximumBytes: 32 * 1024 * 1024,
  };
  const backend = {
    runtimeCommand: ["runtime"],
    record: {} as ContainerBackend["record"],
    workspaceIdentity: "snapshot+world+candidate",
    uploadArchives,
    isolation: {
      kind: "container" as const,
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
  const execute = (workspace: string, asset = "adapter") =>
    runContainerExecution(
      backend,
      {
        workspace,
        assets: [{ name: "driver.mjs", content: asset }],
        executable: "bun",
        args: [],
        environment: {},
        timeoutMs: 1000,
        maximumOutputBytes: 1000,
      },
      runner,
      root,
    );
  try {
    for (const workspace of [first, second])
      await writeFile(path.join(workspace, "value.ts"), "original bytes\n");
    await execute(first);
    await execute(second);
    assert.equal(
      uploadArchives.entries.size,
      1,
      "identical input plans should prepare one archive",
    );
    assert.deepEqual(uploads[0], uploads[1]);
    backend.workspaceIdentity = "different overlay";
    await writeFile(path.join(second, "value.ts"), "changed world\n");
    await execute(second);
    assert.equal(uploadArchives.entries.size, 2);
    assert.ok(gunzipSync(uploads[2] as Buffer).includes(Buffer.from("changed world\n")));
    backend.workspaceIdentity = "snapshot+world+candidate";
    await execute(first, "changed adapter");
    assert.equal(uploadArchives.entries.size, 3, "adapter bytes belong to the archive key");
    const entry = uploadArchives.entries.values().next().value;
    assert.ok(entry);
    entry.bytes[0] = (entry.bytes[0] ?? 0) ^ 0xff;
    await execute(first);
    assert.deepEqual(
      uploads[4],
      uploads[0],
      "a corrupted payload must be regenerated from the fresh workspace",
    );
    assert.ok(uploadArchives.bytes <= uploadArchives.maximumBytes);
    uploadArchives.entries.clear();
    uploadArchives.bytes = 0;
    uploadArchives.maximumBytes = 1;
    await execute(first);
    await execute(first);
    assert.equal(uploadArchives.entries.size, 0, "large archives keep their streaming path");
    assert.equal(uploadArchives.bytes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
