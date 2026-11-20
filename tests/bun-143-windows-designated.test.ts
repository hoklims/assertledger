import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseEvidenceManifestV4, parseEvidenceManifestV5 } from "../src/contracts/index.js";
import { replayEvidenceManifest } from "../src/core/index.js";
import {
  isWindowsX64Bun143,
  permitsWindowsX64Bun143,
} from "../src/engine/adapters/bun-test-designated-profile.js";
import { verifyCampaign } from "../src/engine/index.js";
import { designatedCampaign, designatedRepository, FAULT } from "./support/designated-campaign.js";

const executable = process.env.ASSERTLEDGER_BUN143_EXECUTABLE;
const revision = "c6da4a4d3010e5553438c60f6bd76d981976867c";
const evidenceDirectory = process.env.ASSERTLEDGER_BUN143_EVIDENCE_DIR;

async function retainManifest(name: string, manifest: unknown) {
  if (evidenceDirectory) {
    await writeFile(path.join(evidenceDirectory, name), JSON.stringify(manifest), { flag: "wx" });
  }
}

const windowsNative = {
  kind: "windows-native",
  acknowledgedUnsafeExecution: true,
  environmentAllowlist: ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"],
};

it("admits only the exact version, full revision and platform of the additional profile", () => {
  assert.equal(isWindowsX64Bun143("1.4.3", revision, "win32", "x64"), true);
  for (const [version, hash, platform, arch] of [
    ["1.4.2", revision, "win32", "x64"],
    ["1.4.3", revision.slice(0, 9), "win32", "x64"],
    ["1.4.3", revision.slice(0, -1) + "0", "win32", "x64"],
    ["1.4.3", revision, "linux", "x64"],
    ["1.4.3", revision, "win32", "arm64"],
  ] as const) {
    assert.equal(isWindowsX64Bun143(version, hash, platform, arch), false);
  }
});

it("offers compatibility only for the Windows x64 designated backend", () => {
  assert.equal(
    permitsWindowsX64Bun143("bun-test-designated", "windows-native", "win32", "x64"),
    true,
  );
  for (const [adapter, backend, platform, arch] of [
    ["bun-test", "windows-native", "win32", "x64"],
    ["bun-test-designated", "trusted-local", "win32", "x64"],
    ["bun-test-designated", "container", "win32", "x64"],
    ["bun-test-designated", "windows-native", "linux", "x64"],
    ["bun-test-designated", "windows-native", "win32", "arm64"],
  ] as const) {
    assert.equal(permitsWindowsX64Bun143(adapter, backend, platform, arch), false);
  }
});

describe("Bun 1.4.3 Windows x64 designated qualification", {
  skip: executable === undefined ? "Requires the dedicated Bun 1.4.3 runtime" : false,
}, () => {
  for (const schemaVersion of ["4.0.0", "5.0.0"] as const) {
    it(`attributes the designated matcher and records the actual runtime in evidence ${schemaVersion}`, async (context) => {
      assert.equal(process.platform, "win32");
      assert.equal(process.arch, "x64");
      assert.ok(executable);
      const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-bun143-"));
      context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
      await designatedRepository(root);
      const request = designatedCampaign(root, executable, FAULT, { isolation: windowsNative });
      const manifest =
        schemaVersion === "4.0.0"
          ? parseEvidenceManifestV4(await verifyCampaign(request))
          : parseEvidenceManifestV5(
              await verifyCampaign({
                ...request,
                schemaVersion,
                repository: { ...request.repository, snapshot: "test-closure", include: [] },
                adapter: {
                  ...request.adapter,
                  workingDirectory: "repository-root",
                  isolate: true,
                  trustedMatchers: [],
                },
              }),
            );
      assert.equal(manifest.decision.status, "VERIFIED");
      assert.equal(manifest.isolation.level, "WINDOWS_NATIVE_UNSANDBOXED");
      const adapter = manifest.evidenceContext.adapter.configuration as {
        bunVersion: string;
        bunRevision: string;
        profile: {
          bunVersion: string;
          bunRevision: string;
          capabilities: { supportsContainer: boolean };
        };
      };
      assert.equal(adapter.bunVersion, "1.4.3");
      assert.equal(adapter.bunRevision, revision);
      assert.equal(adapter.profile.bunVersion, adapter.bunVersion);
      assert.equal(adapter.profile.bunRevision, adapter.bunRevision);
      assert.equal(adapter.profile.capabilities.supportsContainer, false);
      for (const [world, expected] of [
        ["reference", "PASS"],
        ["neutral", "PASS"],
        ["target", "ASSERTION_FAILURE"],
      ]) {
        const rows = manifest.observations.filter(
          (row) => row.worldId === world && row.candidateId !== null,
        );
        assert.deepEqual(
          rows.map((row) => row.outcome),
          [expected, expected],
          world,
        );
      }
      assert.equal(replayEvidenceManifest(manifest).valid, true);
      await retainManifest(`verified-${schemaVersion}.json`, manifest);
    });
  }

  it("does not credit an ordinary exception as a designated matcher failure", async (context) => {
    assert.ok(executable);
    const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-bun143-nonassertion-"));
    context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
    await designatedRepository(root);
    const request = designatedCampaign(
      root,
      executable,
      'export const names = () => { throw new Error("calibration failure"); };',
      { isolation: windowsNative },
    );
    const manifest = parseEvidenceManifestV4(await verifyCampaign(request));
    assert.notEqual(manifest.decision.status, "VERIFIED");
    assert.equal(
      manifest.observations.some((row) => row.outcome === "ASSERTION_FAILURE"),
      false,
    );
    await retainManifest("ordinary-exception.json", manifest);
  });
});
