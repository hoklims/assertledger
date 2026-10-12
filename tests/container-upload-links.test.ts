import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, it } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  type BoundedProcessResult,
  type ContainerBackend,
  type ContainerProcessRunner,
  runContainerExecution,
} from "../src/engine/container.js";

const temporaryDirectories: string[] = [];
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

/** Links a directory the way an install does: relative on POSIX, a junction on Windows. */
async function linkDirectory(link: string, target: string): Promise<void> {
  await symlink(
    process.platform === "win32" ? target : path.relative(path.dirname(link), target),
    link,
    directoryLinkType,
  );
}

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

/** Runs one execution through a fake runtime and returns the entries of the uploaded tar. */
async function uploadedEntries(workspace: string) {
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
  await runContainerExecution(
    backend,
    {
      workspace,
      assets: [],
      executable: "bun",
      args: [],
      environment: {},
      timeoutMs: 1000,
      maximumOutputBytes: 1000,
    },
    runner,
    workspace,
  );
  const archive = gunzipSync(uploaded);
  const entries: Array<{ name: string; type: string; linkName: string }> = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii"), 8);
    entries.push({
      name: header.subarray(0, 100).toString("utf8").replace(/\0.*$/su, ""),
      type: String.fromCharCode(header[156] as number),
      linkName: header.subarray(157, 257).toString("utf8").replace(/\0.*$/su, ""),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

it("uploads a workspace link as a symbolic link entry with its relative target", async () => {
  const workspace = await temporaryDirectory("assertledger-upload-links-");
  await mkdir(path.join(workspace, "tools", "compat"), { recursive: true });
  await writeFile(path.join(workspace, "tools", "compat", "index.ts"), "export {};\n");
  await mkdir(path.join(workspace, "web", "node_modules"), { recursive: true });
  await linkDirectory(
    path.join(workspace, "web", "node_modules", "compat"),
    path.join(workspace, "tools", "compat"),
  );
  const entries = await uploadedEntries(workspace);
  assert.deepEqual(
    entries.find((entry) => entry.name === "repository/web/node_modules/compat"),
    {
      name: "repository/web/node_modules/compat",
      type: "2",
      linkName: "../../tools/compat",
    },
  );
  assert.equal(
    entries.some((entry) => entry.name.startsWith("repository/web/node_modules/compat/")),
    false,
    "a link is not followed into a copy of its target",
  );
});

it("refuses a workspace link whose target leaves the workspace", async () => {
  const workspace = await temporaryDirectory("assertledger-upload-links-");
  const outside = await temporaryDirectory("assertledger-upload-outside-");
  await linkDirectory(path.join(workspace, "escape"), outside);
  await assert.rejects(uploadedEntries(workspace), /CONTAINER_WORKSPACE_ENTRY_UNSUPPORTED/u);
});
