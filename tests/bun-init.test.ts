import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { runCli, type CliIo } from "../src/cli.js";
import { initializeRepository } from "../src/engine/index.js";

it("initializes a Bun test repository with the official v2 adapter configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-bun-init-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "bun-fixture",
        packageManager: "bun@1.4.2",
        scripts: { test: "bun test" },
      }),
    );
    await writeFile(path.join(root, "bun.lock"), "");
    await writeFile(
      path.join(root, "base.test.ts"),
      'import { test } from "bun:test"; test("base", () => {});\n',
    );
    const plan = await initializeRepository(root, { dryRun: true });
    assert.equal(plan.status, "WOULD_CREATE");
    assert.equal(plan.schemaVersion, "2.0.0");
    assert.equal(plan.detections.framework, "bun:test");
    assert.equal(plan.detections.adapterRecommendation, "bun-test");
    const config = JSON.parse(
      plan.files.find((file) => file.path === "assertledger.config.json")?.content ?? "null",
    ) as Record<string, unknown>;
    assert.equal(config.schemaVersion, "2.0.0");
    assert.deepEqual(config.adapter, {
      kind: "bun-test",
      executable: "bun",
      baseTestFiles: ["base.test.ts"],
    });
    const lock = JSON.parse(
      plan.files.find((file) => file.path === "assertledger.lock.json")?.content ?? "null",
    ) as Record<string, unknown>;
    assert.equal(lock.schemaVersion, "2.0.0");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

it("retains an explicit Bun choice and excludes node:test controls in a mixed repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-mixed-bun-init-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "mixed", packageManager: "bun@1.4.2", scripts: { test: "bun test" } }),
    );
    await writeFile(path.join(root, "bun.lock"), "");
    await writeFile(
      path.join(root, "bun.test.ts"),
      'import { test } from "bun:test"; test("bun", () => {});\n',
    );
    await writeFile(
      path.join(root, "node.test.ts"),
      'import test from "node:test"; test("node", () => {});\n',
    );
    const created = await initializeRepository(root, { framework: "bun:test" });
    assert.equal(created.status, "CREATED");
    const config = JSON.parse(
      created.files.find((file) => file.path === "assertledger.config.json")?.content ?? "null",
    ) as { adapter: { baseTestFiles: string[] } };
    assert.deepEqual(config.adapter.baseTestFiles, ["bun.test.ts"]);
    const repeated = await initializeRepository(root, { dryRun: true });
    assert.equal(repeated.status, "UNCHANGED");
    assert.equal(repeated.detections.framework, "bun:test");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

it("accepts an explicit Bun framework in the static CLI doctor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-bun-doctor-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "mixed", packageManager: "bun@1.4.2", scripts: { test: "bun test" } }),
    );
    await writeFile(path.join(root, "bun.lock"), "");
    await writeFile(
      path.join(root, "bun.test.ts"),
      'import { test } from "bun:test"; test("bun", () => {});\n',
    );
    await writeFile(
      path.join(root, "node.test.ts"),
      'import test from "node:test"; test("node", () => {});\n',
    );
    let stdout = "";
    const io: CliIo = {
      cwd: root,
      readStdin: async () => "",
      writeStdout: (value) => {
        stdout += value;
      },
      writeStderr: () => {},
    };
    assert.equal(
      await runCli(["doctor", root, "--framework", "bun:test", "--json"], io),
      0,
      stdout,
    );
    const result = JSON.parse(stdout) as {
      schemaVersion: string;
      detections: { framework: string };
    };
    assert.equal(result.schemaVersion, "2.0.0");
    assert.equal(result.detections.framework, "bun:test");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
