import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEvidenceManifestV4, parseEvidenceManifestV5 } from "../src/contracts/index.js";
import { replayEvidenceManifest } from "../src/core/index.js";

const directory = process.env.ASSERTLEDGER_BUN143_EVIDENCE_DIR;
assert.ok(directory, "The Windows qualification job must supply a fresh evidence directory");
for (const [file, schema, decision, target] of [
  ["verified-4.0.0.json", "4.0.0", "VERIFIED", "ASSERTION_FAILURE"],
  ["verified-5.0.0.json", "5.0.0", "VERIFIED", "ASSERTION_FAILURE"],
  ["ordinary-exception.json", "4.0.0", "REJECTED", "PROCESS_CRASH"],
] as const) {
  const recorded: unknown = JSON.parse(await readFile(path.join(directory, file), "utf8"));
  const manifest =
    schema === "4.0.0" ? parseEvidenceManifestV4(recorded) : parseEvidenceManifestV5(recorded);
  assert.equal(replayEvidenceManifest(manifest).valid, true, file);
  assert.equal(manifest.decision.status, decision, file);
  assert.equal(manifest.isolation.level, "WINDOWS_NATIVE_UNSANDBOXED", file);
  const configuration = manifest.evidenceContext.adapter.configuration;
  assert.ok(
    configuration && typeof configuration === "object" && !Array.isArray(configuration),
    file,
  );
  assert.equal(configuration.bunVersion, "1.4.3", file);
  assert.equal(configuration.bunRevision, "c6da4a4d3010e5553438c60f6bd76d981976867c", file);
  const profile = configuration.profile;
  assert.ok(profile && typeof profile === "object" && !Array.isArray(profile), file);
  assert.equal(profile.profileId, "bun-test-designated", file);
  assert.equal(profile.profileVersion, "1.1.0", file);
  assert.equal(profile.platform, "win32", file);
  assert.equal(profile.arch, "x64", file);
  for (const [world, outcome] of [
    ["reference", "PASS"],
    ["neutral", "PASS"],
    ["target", target],
  ]) {
    const rows = manifest.observations.filter(
      (row) => row.worldId === world && row.candidateId === "designated",
    );
    assert.deepEqual(
      rows.map((row) => row.outcome),
      [outcome, outcome],
      file,
    );
  }
  console.log(`${file} replayed with decision ${decision}`);
}
