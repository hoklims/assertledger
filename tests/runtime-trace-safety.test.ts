import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workerThreads, { type WorkerOptions } from "node:worker_threads";
import {
  RuntimeTraceQueue,
  traceOperation,
  withRuntimeTrace,
} from "../src/engine/runtime-trace.js";

async function fixture(operation: (root: string) => Promise<void>): Promise<void> {
  const root = await fsPromises.mkdtemp(join(tmpdir(), "assertledger-trace-"));
  const previous = process.env.ASSERTLEDGER_RUNTIME_TRACE;
  try {
    await operation(root);
  } finally {
    if (previous === undefined) delete process.env.ASSERTLEDGER_RUNTIME_TRACE;
    else process.env.ASSERTLEDGER_RUNTIME_TRACE = previous;
    await fsPromises.rm(root, { recursive: true, force: true });
  }
}

test("a slow diagnostic writer does not delay the next lifecycle operation", {
  timeout: 5000,
}, async (context) => {
  const OriginalWorker = workerThreads.Worker;
  let entered: (() => void) | undefined;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  // Stall the actual writeSync inside the engine's worker, after its ready handshake.
  const prefix = `(() => {
    const fs = require('node:fs');
    const { parentPort } = require('node:worker_threads');
    const write = fs.writeSync;
    fs.writeSync = (...args) => {
      parentPort.postMessage('writer-blocked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      return write(...args);
    };
  })();`;
  context.mock.method(
    workerThreads,
    "Worker",
    class extends OriginalWorker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        super(prefix + String(filename), options);
        this.on("message", (message) => {
          if (message === "writer-blocked") entered?.();
        });
      }
    },
  );
  syncBuiltinESMExports();
  try {
    await fixture(async (root) => {
      process.env.ASSERTLEDGER_RUNTIME_TRACE = join(root, "trace.jsonl");
      await withRuntimeTrace([], async () => {
        const result = await traceOperation("start", {}, async () => "TIMEOUT");
        assert.equal(result, "TIMEOUT");
        await writing;
        const start = performance.now();
        assert.equal(await traceOperation("kill", {}, async () => "PASS"), "PASS");
        assert.ok(performance.now() - start < 100, "diagnostics delayed the next container kill");
      });
    });
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("fresh outside trace flushes events without changing the result", async () => {
  await fixture(async (root) => {
    const destination = join(root, "trace.jsonl");
    process.env.ASSERTLEDGER_RUNTIME_TRACE = destination;
    const result = await withRuntimeTrace([join(root, "repo")], async () => {
      await traceOperation("start", { container: "owned", timeoutMs: 42 }, async () => "TIMEOUT");
      return traceOperation("kill", { container: "owned" }, async () => "PASS");
    });
    assert.equal(result, "PASS");
    const events = (await fsPromises.readFile(destination, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.phase),
      ["start", "kill"],
    );
    assert.equal(events[0].container, "owned");
    assert.equal(events[0].timeoutMs, 42);
    assert.ok(events.every((event) => event.durationMs >= 0));
  });
});

test("repository and output reservations are never created or overwritten", async () => {
  await fixture(async (root) => {
    const repo = join(root, "repo");
    await fsPromises.mkdir(repo);
    const source = join(repo, "source.ts");
    await fsPromises.writeFile(source, "unchanged source");
    for (const destination of [source, join(repo, "new.jsonl"), join(root, "out.json")]) {
      process.env.ASSERTLEDGER_RUNTIME_TRACE = destination;
      assert.equal(
        await withRuntimeTrace([repo, join(root, "out.json")], async () =>
          traceOperation("create", {}, async () => "original verdict"),
        ),
        "original verdict",
      );
    }
    assert.equal(await fsPromises.readFile(source, "utf8"), "unchanged source");
    assert.deepEqual(await fsPromises.readdir(repo), ["source.ts"]);
    assert.deepEqual((await fsPromises.readdir(root)).sort(), ["repo"]);
  });
});

test("existing outside files and sink failure preserve inputs and original errors", async () => {
  await fixture(async (root) => {
    const destination = join(root, "existing.jsonl");
    await fsPromises.writeFile(destination, "unchanged outside input");
    process.env.ASSERTLEDGER_RUNTIME_TRACE = destination;
    const original = new Error("original proof error");
    await assert.rejects(
      withRuntimeTrace([], async () => {
        throw original;
      }),
      (error) => error === original,
    );
    assert.equal(await fsPromises.readFile(destination, "utf8"), "unchanged outside input");
  });
});

test("unacknowledged diagnostic writes have a finite queue and consume no lifecycle wait", () => {
  let published = 0;
  const queue = new RuntimeTraceQueue(() => {
    published++;
  });
  for (let index = 0; index < 10000; index++) queue.enqueue("{}\n");
  assert.equal(published, 512);
  queue.acknowledge();
  queue.enqueue("{}\n");
  assert.equal(published, 513);
  queue.acknowledge();
  queue.enqueue("x".repeat(4097));
  assert.equal(published, 513);
});

test("nested reservations disable unsafe tracing and serialization cannot replace an outcome", async () => {
  await fixture(async (root) => {
    const destination = join(root, "trace.jsonl");
    process.env.ASSERTLEDGER_RUNTIME_TRACE = destination;
    await withRuntimeTrace([], async () => {
      assert.equal(
        await withRuntimeTrace([root], async () => traceOperation("forbidden", {}, async () => 1)),
        1,
      );
      assert.equal(
        await traceOperation(
          "facts",
          {},
          async () => 2,
          () => {
            throw new Error("bad diagnostic");
          },
        ),
        2,
      );
      await traceOperation("final", {}, async () => 3);
    });
    const events = (await fsPromises.readFile(destination, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.phase),
      ["final"],
    );
  });
});
