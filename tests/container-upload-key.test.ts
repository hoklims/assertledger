import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseEvidenceManifestV2 } from "../src/contracts/index.js";
import { verifyCampaign } from "../src/engine/index.js";

const runtime = fileURLToPath(new URL("./support/fake-container-runtime.mjs", import.meta.url));

it("keys campaign upload bytes by every actual world and candidate overlay", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assertledger-upload-key-"));
  const root = path.join(directory, "repository");
  const state = path.join(directory, "runtime");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(state);
  await writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(path.join(root, "src", "value.js"), "base repository\n");
  await writeFile(path.join(state, "scenario.json"), "{}");
  const worlds = [
    { id: "fixed", kind: "REFERENCE", weight: 0, content: "reference overlay\n" },
    { id: "bug", kind: "TARGET", weight: 1, content: "// BUG\ntarget overlay\n" },
    { id: "neutral", kind: "NEUTRAL", weight: 0, content: "neutral overlay\n" },
  ];
  const candidates = [
    { id: "first", content: "first candidate bytes\n" },
    { id: "second", content: "second candidate bytes\n" },
  ];
  try {
    const manifest = await verifyCampaign(
      {
        schemaVersion: "2.0.0",
        repository: { root, exclude: [] },
        adapter: {
          kind: "testforge-command",
          executable: "fake-adapter",
          arguments: ["--run"],
          protocolVersion: "1.0.0",
        },
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
        candidateRoots: ["tests"],
        budgets: {
          maximumCandidates: 2,
          maximumWorlds: 3,
          maximumExecutions: 9,
          maximumRepositoryFiles: 100,
          maximumRepositoryBytes: 1_000_000,
          maximumWorldOverlayBytes: 100_000,
          maximumCandidateBytes: 10_000,
          maximumTotalCandidateBytes: 20_000,
          timeoutMsPerExecution: 20_000,
          maximumOutputBytes: 65_536,
        },
        policy: {
          policyVersion: "1.0.0",
          requiredAttempts: 1,
          minimumTargetWeightPermille: 1000,
          maximumSelectedCandidates: 1,
          acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
        },
        worlds: worlds.map(({ content, ...world }) => ({
          ...world,
          required: true,
          provenance: `fixture:${world.id}`,
          files: [{ path: "src/value.js", content }],
        })),
        candidates: candidates.map(({ id, content }) => ({
          id,
          files: [{ path: "tests/value.test.js", content }],
        })),
      },
      { containerRuntime: { command: [process.execPath, runtime, state], transport: "cli" } },
    );
    const calls = (await readFile(path.join(state, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const creates = calls.filter((call) => call[0] === "create");
    const expectedExecutions = [null, ...candidates].flatMap((candidate) =>
      worlds.map((world) => ({ candidate, world })),
    );
    assert.equal(creates.length, expectedExecutions.length);
    for (const [index, expected] of expectedExecutions.entries()) {
      const name = creates[index]?.find((argument) => argument.startsWith("--name="))?.slice(7);
      assert.ok(name);
      const entries = JSON.parse(
        await readFile(path.join(state, "containers", name, "upload.json"), "utf8"),
      ) as Array<{ name: string; type: string; text: string }>;
      const actualFiles = Object.fromEntries(
        entries.filter((entry) => entry.type === "0").map((entry) => [entry.name, entry.text]),
      );
      assert.deepEqual(
        actualFiles,
        {
          "repository/package.json": '{"type":"module"}\n',
          "repository/src/value.js": expected.world.content,
          ...(expected.candidate === null
            ? {}
            : { "repository/tests/value.test.js": expected.candidate.content }),
        },
        `archive for world ${expected.world.id}, candidate ${expected.candidate?.id ?? "load"}`,
      );
    }
    const parsed = parseEvidenceManifestV2(manifest);
    assert.equal(parsed.decision.status, "VERIFIED");
    assert.equal(parsed.observations.length, 9);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
