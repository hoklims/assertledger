import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { parseEvidenceManifestV4 } from "../src/contracts/index.js";
import { replayEvidenceManifest } from "../src/core/index.js";
import { collectBunNative } from "../src/engine/adapters/bun-native.js";
import { doctorRepositoryRuntime, initializeRepository } from "../src/engine/index.js";

const QUALIFIED = {
  version: "1.4.4",
  revision: "38afee6c84fcf48c0edb2466aa4b27d287a59c30",
  short: "1.4.4+38afee6c8",
} as const;
/** The runtime qualified before the move: it must now be refused, never counted as a kill. */
const HISTORICAL = {
  version: "1.4.2",
  revision: "744846f844374847c902b5e7fd59b4342a51ef99",
} as const;

const UNSUPPORTED_RUNTIMES = [
  HISTORICAL,
  { version: "1.4.3", revision: "c6da4a4d3010e5553438c60f6bd76d981976867c" },
  { version: "1.4.4", revision: "5d9cc0f4ff81c4dacf8f6952d44aa9cea4f48653" },
] as const;

const root = fileURLToPath(new URL("..", import.meta.url));
/** Fakes only the executable boundary; identity gates, digests and result handling stay real. */
function fakeSpawn(context: TestContext, identity: unknown) {
  const spawned: string[][] = [];
  const mocked = context.mock.method(childProcess, "spawn", ((_command: string, args: string[]) => {
    spawned.push(args);
    const probe = args[0] === "-e";
    assert.ok(probe || args[0]?.endsWith("driver.mjs"), `unexpected subprocess: ${args[0]}`);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new ChildProcess(), {
      stdout,
      stderr,
      stdin: null,
      pid: undefined,
    });
    queueMicrotask(() => {
      stdout.end(probe ? JSON.stringify(identity) : "");
      stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  }) as unknown as typeof childProcess.spawn);
  syncBuiltinESMExports();
  context.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  return spawned;
}

describe("a Bun runtime other than the qualified one is refused, never judged", () => {
  const input = (cwd: string) => ({
    executable: "bun",
    files: ["case.test.ts"],
    cwd,
    environment: {},
    timeoutMs: 5_000,
    maximumOutputBytes: 65_536,
  });

  for (const runtime of UNSUPPORTED_RUNTIMES) {
    it(`makes the native collector refuse Bun ${runtime.version}+${runtime.revision.slice(0, 9)} as infrastructure failure`, async (context) => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "assertledger-bun-pin-"));
      context.after(() => rm(cwd, { recursive: true, force: true }));
      const spawned = fakeSpawn(context, {
        execPath: process.execPath,
        revision: `${runtime.version}+${runtime.revision}`,
      });
      const result = await collectBunNative(input(cwd));
      assert.equal(result.state, "INFRA_ERROR");
      assert.equal(result.facts.attributed, false);
      assert.equal(result.facts.testsDiscovered, 0);
      assert.equal(result.runtime.executableDigest, "", "no binary identity is claimed");
      assert.equal(spawned.length, 1, "refused before the driver ran any test");
    });
  }

  it("lets the native collector reach its driver for the qualified runtime", async (context) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "assertledger-bun-pin-"));
    context.after(() => rm(cwd, { recursive: true, force: true }));
    const spawned = fakeSpawn(context, {
      execPath: process.execPath,
      revision: `${QUALIFIED.version}+${QUALIFIED.revision}`,
    });
    const result = await collectBunNative(input(cwd));
    assert.equal(result.runtime.bunRevision, QUALIFIED.short);
    assert.match(result.runtime.executableDigest, /^[a-f0-9]{64}$/u);
    assert.equal(spawned.length, 2, "identity probe, then the driver");
  });

  for (const runtime of UNSUPPORTED_RUNTIMES) {
    it(`blocks the runtime doctor on Bun ${runtime.version}+${runtime.revision.slice(0, 9)} without probing dependencies`, async (context) => {
      const repository = await mkdtemp(path.join(os.tmpdir(), "assertledger-bun-pin-doctor-"));
      context.after(() => rm(repository, { recursive: true, force: true, maxRetries: 5 }));
      await writeFile(
        path.join(repository, "package.json"),
        JSON.stringify({ name: "bun-fixture", scripts: { test: "bun test" } }),
      );
      await writeFile(path.join(repository, "bun.lock"), "");
      await writeFile(
        path.join(repository, "base.test.ts"),
        'import { test } from "bun:test"; test("base", () => {});\n',
      );
      assert.equal((await initializeRepository(repository)).status, "CREATED");
      const spawned = fakeSpawn(context, {
        execPath: process.execPath,
        bunVersion: runtime.version,
        bunRevision: runtime.revision,
      });
      const result = await doctorRepositoryRuntime(repository, { allowUnsafeExecution: true });
      assert.notEqual(result.status, "READY");
      assert.ok(
        (result.reasonCodes as readonly string[]).includes("RUNTIME_BUN_VERSION_UNSUPPORTED"),
        JSON.stringify(result.reasonCodes),
      );
      assert.equal(spawned.length, 1, "only the identity probe ran");
    });
  }
});

describe("evidence sealed under the previous Bun stays valid for that runtime", () => {
  const directory = path.join(root, "benchmarks/container-runtime/2026-10-11");
  const manifests = readdirSync(directory)
    .filter((name) => name.endsWith(".manifest.json.gz"))
    .sort();
  const gunzip = (name: string): any =>
    JSON.parse(gunzipSync(readFileSync(path.join(directory, name))).toString("utf8"));

  it("has real manifests to replay", () => {
    assert.ok(manifests.length >= 12, `found ${manifests.length}`);
  });

  it("parses and replays them without consulting the current pin", () => {
    for (const name of manifests) {
      const manifest = parseEvidenceManifestV4(gunzip(name));
      const configuration = manifest.evidenceContext.adapter.configuration as {
        bunVersion: string;
        bunRevision: string;
      };
      assert.equal(configuration.bunVersion, HISTORICAL.version, name);
      assert.equal(configuration.bunRevision, HISTORICAL.revision, name);
      const replay = replayEvidenceManifest(manifest);
      assert.equal(replay.valid, true, name);
      // The replay recorded next to the manifest predates the current replay result's field set:
      // it must still agree on the verdict and on every field both of them report.
      const recorded = gunzip(name.replace(".manifest.", ".replay."));
      assert.equal(recorded.valid, true, name);
      const current = replay as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(recorded)) {
        if (key in current) assert.equal(current[key], value, `${name}:${key}`);
      }
    }
  });

  it("keeps the digests those manifests were sealed with", () => {
    // Literals taken from the tracked manifest before the pin moved: the digest projection did not.
    const manifest = parseEvidenceManifestV4(gunzip("matched-before-1.manifest.json.gz"));
    assert.equal(
      manifest.decisionDigest,
      "sha256:cced6d46aeb465e69494a67cb422bebdfe09fd6485af9796143705dd2ae8a482",
    );
    assert.equal(
      manifest.artifactDigest,
      "sha256:0720ec06e5fda010bbaa24a824935f72089af30a2e6fed8ccf69b86f4e5b0037",
    );
  });
});
