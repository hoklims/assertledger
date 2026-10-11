import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import {
  type BoundedProcessResult,
  type ContainerBackend,
  type ContainerProcessRunner,
  runContainerExecution,
} from "../src/engine/container.js";

it("traces runtime phases and upload bytes without changing execution evidence or exposing inputs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assertledger-runtime-trace-"));
  const trace = path.join(directory, "trace.jsonl");
  const workspace = path.join(directory, "workspace");
  const previous = process.env.ASSERTLEDGER_RUNTIME_TRACE;
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
  const runner: ContainerProcessRunner = async (input, stdin) => {
    if (stdin)
      for await (const _chunk of stdin) {
        /* Consume the real archive once. */
      }
    if (input.args[0] === "inspect") {
      return {
        ...result,
        stdoutBytes: Buffer.from(
          JSON.stringify({
            Status: "exited",
            ExitCode: 0,
            Error: "",
            StartedAt: "2026-10-11T00:00:00Z",
          }),
        ),
      };
    }
    return result;
  };
  const backend: ContainerBackend = {
    runtimeCommand: ["fake-runtime"],
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
    record: {} as ContainerBackend["record"],
  };
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, "input.txt"), "private file contents");
    const execution = {
      workspace,
      executable: "private-executable",
      args: ["private-argument"],
      environment: { SECRET: "private-environment" },
      timeoutMs: 1000,
      maximumOutputBytes: 1000,
    };
    delete process.env.ASSERTLEDGER_RUNTIME_TRACE;
    const untraced = await runContainerExecution(backend, execution, runner, directory);
    process.env.ASSERTLEDGER_RUNTIME_TRACE = trace;
    const traced = await runContainerExecution(backend, execution, runner, directory);
    assert.deepEqual(traced, untraced);
    const text = await readFile(trace, "utf8").catch(() => "");
    const events = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.phase),
      ["create", "upload", "start", "inspect", "remove"],
    );
    assert.equal(new Set(events.map((event) => event.container)).size, 1);
    assert.ok(events.every((event) => event.durationMs >= 0 && event.outcome === "PASS"));
    assert.ok(events.find((event) => event.phase === "upload").inputBytes > 0);
    assert.doesNotMatch(text, /private-|SECRET|file contents/);
    process.env.ASSERTLEDGER_RUNTIME_TRACE = directory; // A failed diagnostic must not change evidence.
    await assert.doesNotReject(async () => {
      assert.deepEqual(
        await runContainerExecution(backend, execution, runner, directory),
        untraced,
      );
    });
  } finally {
    if (previous === undefined) delete process.env.ASSERTLEDGER_RUNTIME_TRACE;
    else process.env.ASSERTLEDGER_RUNTIME_TRACE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
