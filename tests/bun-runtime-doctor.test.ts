import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { doctorRepositoryRuntime, initializeRepository } from "../src/engine/index.js";

it("qualifies the generated Bun adapter with controlled callback probes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-bun-doctor-"));
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
    const init = await initializeRepository(root);
    assert.equal(init.status, "CREATED");
    const result = await doctorRepositoryRuntime(root, { allowUnsafeExecution: true });
    assert.equal(result.status, "READY", JSON.stringify(result));
    assert.equal(result.schemaVersion, "2.0.0");
    assert.equal(result.adapter, "bun:test");
    assert.equal(result.bunVersion, "1.4.2");
    assert.equal(result.reasonCodes.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
