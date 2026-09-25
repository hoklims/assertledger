import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseEvidenceManifestV3 } from "../src/contracts/index.js";
import { replayEvidenceManifest } from "../src/core/index.js";
import { verifyCampaign } from "../src/engine/index.js";

const temporaryDirectories: string[] = [];
const bunExecutable = process.env.ASSERTLEDGER_BUN_EXECUTABLE ?? "bun";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-bun-campaign-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "tests"));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(root, "src", "subject.ts"), "export const subject = () => true;\n");
  await writeFile(
    path.join(root, "tests", "base.test.ts"),
    'import { test } from "bun:test"; test("control", () => {});\n',
  );
  return root;
}

function request(root: string, candidateSource: string) {
  return {
    schemaVersion: "3.0.0",
    repository: { root, exclude: ["node_modules", ".git", ".testforge"] },
    adapter: {
      kind: "bun-test",
      executable: bunExecutable,
      baseTestFiles: ["tests/base.test.ts"],
    },
    isolation: {
      kind: "trusted-local",
      acknowledgedUnsafeExecution: true,
      environmentAllowlist: ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"],
    },
    candidateRoots: ["tests/candidates"],
    budgets: {
      maximumCandidates: 1,
      maximumWorlds: 3,
      maximumExecutions: 12,
      maximumRepositoryFiles: 100,
      maximumRepositoryBytes: 1_000_000,
      maximumWorldOverlayBytes: 10_000,
      maximumCandidateBytes: 10_000,
      maximumTotalCandidateBytes: 10_000,
      timeoutMsPerExecution: 10_000,
      maximumOutputBytes: 65_536,
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 2,
      minimumTargetWeightPermille: 1_000,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds: [
      {
        id: "reference",
        kind: "REFERENCE",
        required: true,
        weight: 0,
        provenance: "fixture:correct",
        files: [],
      },
      {
        id: "target",
        kind: "TARGET",
        required: true,
        weight: 1,
        provenance: "fixture:fault",
        files: [{ path: "src/subject.ts", content: "export const subject = () => false;\n" }],
      },
      {
        id: "neutral",
        kind: "NEUTRAL",
        required: true,
        weight: 0,
        provenance: "fixture:equivalent",
        files: [],
      },
    ],
    candidates: [
      {
        id: "candidate",
        files: [{ path: "tests/candidates/candidate.test.ts", content: candidateSource }],
      },
    ],
  };
}

const strongCandidate = [
  'import { test } from "bun:test";',
  'import { assertSame } from "assertledger/bun";',
  'import { subject } from "../../src/subject.ts";',
  'test("subject stays true", () => assertSame(subject(), true));',
  "",
].join("\n");

describe("official Bun test adapter", () => {
  it("binds Bun 1.4.2 identity and replays a real assertion campaign", async () => {
    const manifest = parseEvidenceManifestV3(
      await verifyCampaign(request(await fixture(), strongCandidate)),
    );
    assert.equal(manifest.decision.status, "VERIFIED");
    assert.deepEqual(manifest.decision.selectedCandidateIds, ["candidate"]);
    const targetRuns = manifest.observations.filter(
      (run) => run.candidateId === "candidate" && run.worldId === "target",
    );
    assert.equal(targetRuns.length, 2);
    assert.ok(targetRuns.every((run) => run.outcome === "ASSERTION_FAILURE" && run.attributed));
    assert.equal(manifest.evidenceContext.adapter.version, "1.4.2");
    assert.equal(manifest.evidenceContext.adapter.name, "bun-test");
    const configuration = manifest.evidenceContext.adapter.configuration as {
      profile: { capabilities: { reporterTransport: string } };
      preloadDigest: string;
      runtimePreflight: { probes: Array<{ name: string; outcome: string }> };
    };
    assert.equal(configuration.profile.capabilities.reporterTransport, "signed-preload-pipe+junit");
    assert.match(configuration.preloadDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(
      configuration.runtimePreflight.probes.some(
        (probe) => probe.name === "hook-failure" && probe.outcome === "INFRA_ERROR",
      ),
    );
    assert.ok(
      configuration.runtimePreflight.probes.some(
        (probe) => probe.name === "replayed-assertion" && probe.outcome === "PROCESS_CRASH",
      ),
    );
    assert.ok(
      configuration.runtimePreflight.probes.some(
        (probe) => probe.name === "replayed-row" && probe.outcome === "PROCESS_CRASH",
      ),
    );
    assert.equal(manifest.adapter.kind, "bun-test");
    assert.deepEqual(replayEvidenceManifest(manifest).valid, true);
  });

  it("keeps a generic throw non-attributed even on the target world", async () => {
    const source = [
      'import { test } from "bun:test";',
      'import { subject } from "../../src/subject.ts";',
      'test("generic", () => { subject(); throw new Error("generic"); });',
      "",
    ].join("\n");
    const manifest = parseEvidenceManifestV3(
      await verifyCampaign(request(await fixture(), source)),
    );
    const targetRuns = manifest.observations.filter(
      (run) => run.candidateId === "candidate" && run.worldId === "target",
    );
    assert.equal(targetRuns.length, 2);
    assert.ok(targetRuns.every((run) => run.outcome === "PROCESS_CRASH" && !run.attributed));
    assert.notEqual(manifest.decision.status, "VERIFIED");
    assert.equal(replayEvidenceManifest(manifest).valid, true);
  });

  it("does not accept a candidate-written engine report as an assertion kill", async () => {
    const source = [
      'import { test } from "bun:test";',
      'import { writeFileSync } from "node:fs";',
      'test("forged", () => {',
      "  const file = process.env.TESTFORGE_RESULT_FILE;",
      '  if (file) writeFileSync(file, JSON.stringify({ protocolVersion: "1.0.0", outcome: "ASSERTION_FAILURE", testsDiscovered: 2, candidateTestsDiscovered: 1, attributed: true }));',
      '  throw new Error("generic");',
      "});",
      "",
    ].join("\n");
    const manifest = parseEvidenceManifestV3(
      await verifyCampaign(request(await fixture(), source)),
    );
    const targetRuns = manifest.observations.filter(
      (run) => run.candidateId === "candidate" && run.worldId === "target",
    );
    assert.equal(targetRuns.length, 2);
    assert.ok(targetRuns.every((run) => run.outcome === "PROCESS_CRASH" && !run.attributed));
    assert.notEqual(manifest.decision.status, "VERIFIED");
    assert.equal(replayEvidenceManifest(manifest).valid, true);
  });

  it("treats a Bun test that outlives the engine deadline as a non-kill timeout", async () => {
    const source = [
      'import { test } from "bun:test";',
      'test("hang", async () => { await new Promise(() => {}); });',
      "",
    ].join("\n");
    const input = request(await fixture(), source);
    input.policy.requiredAttempts = 1;
    input.budgets.maximumExecutions = 6;
    input.budgets.timeoutMsPerExecution = 2_500;
    const manifest = parseEvidenceManifestV3(await verifyCampaign(input));
    const targetRuns = manifest.observations.filter(
      (run) => run.candidateId === "candidate" && run.worldId === "target",
    );
    assert.equal(targetRuns.length, 1);
    assert.equal(targetRuns[0]?.outcome, "TIMEOUT");
    assert.equal(targetRuns[0]?.attributed, false);
    assert.notEqual(manifest.decision.status, "VERIFIED");
    assert.equal(replayEvidenceManifest(manifest).valid, true);
  });
});
