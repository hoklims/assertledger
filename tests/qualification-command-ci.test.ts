import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { QualificationPlan } from "../src/contracts/qualification.js";
import { sha256Canonical } from "../src/core/index.js";
import {
  qualificationFileDigest,
  qualificationRepositoryDigest,
  qualifyOrchestration,
} from "../src/engine/qualification.js";

const completion = `import {writeFileSync} from 'node:fs';
const exitCode=7;
writeFileSync(process.env.ASSERTLEDGER_QUALIFICATION_RESULT_FILE, JSON.stringify({facts:{commandOutcome:'EXPECTED_FAILURE',exitCode},nonce:process.env.ASSERTLEDGER_QUALIFICATION_NONCE,protocolVersion:'1.0.0'})+'\\n');
process.exit(exitCode);\n`;

async function execute(
  reference: string,
  targets: Array<{ id: string; content: string }>,
  adapter: "command" | "ci-config" = "command",
  expected: QualificationPlan["obligations"][number]["checks"][number]["expected"] = 7,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qualification-command-ci-"));
  try {
    const file = adapter === "command" ? "action.mjs" : "pipeline.yml";
    await writeFile(path.join(root, file), reference);
    const bunProbe =
      adapter === "ci-config"
        ? spawnSync("bun", ["-e", "console.log(process.execPath)"], { encoding: "utf8" })
        : null;
    if (bunProbe !== null)
      assert.equal(bunProbe.status, 0, "Bun runtime is required by CI configuration witnesses");
    const executable = bunProbe?.stdout.trim() ?? process.execPath;
    const plan: QualificationPlan = {
      schemaVersion: "1.0.0",
      profileId: "completion-witness",
      subject: {
        commit: "fixture",
        baseCommit: "fixture",
        candidateDigest: sha256Canonical([]),
        inputDigest: await qualificationRepositoryDigest(root),
      },
      tools: [
        {
          id: "runtime",
          version: spawnSync(executable, ["--version"], { encoding: "utf8" })
            .stdout.trim()
            .replace(/^v/u, ""),
          digest: await qualificationFileDigest(executable),
        },
      ],
      suites: [],
      allowedCandidatePaths: [],
      obligations: [
        {
          id: "completion",
          kind: adapter === "command" ? "propagation" : "ci-config",
          required: true,
          suiteIds: [],
          limits: [],
          checks: [
            {
              id: "semantic",
              actionId: "action",
              field: adapter === "command" ? "exitCode" : "ciRoutes",
              expected,
            },
          ],
        },
      ],
      actions: [
        {
          id: "action",
          adapter,
          executable,
          arguments: [file],
          environment: {},
          prepareFiles: [],
          removePaths: [],
          observe: { trace: false, outputs: [], report: null },
        },
      ],
      worlds: [
        { id: "reference", kind: "REFERENCE", files: [], discriminants: [] },
        { id: "neutral", kind: "NEUTRAL", files: [], discriminants: [] },
        ...targets.map(({ id, content }) => ({
          id,
          kind: "TARGET" as const,
          files: [{ path: file, content }],
          discriminants: [{ obligationId: "completion", checkIds: ["semantic"] }],
        })),
      ],
      requiredAttempts: 2,
      timeoutMs: 5000,
      maximumOutputBytes: 65536,
      isolation: { kind: "trusted-local", acknowledgedUnsafeExecution: true },
    };
    return await qualifyOrchestration(
      { root, plan, planDigest: sha256Canonical(plan), candidate: { files: [] } },
      { allowUnsafeExecution: true },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [id, content] of [
  ["ordinary-error", "throw new Error('ordinary failure');\n"],
  ["compilation", "const value = ;\n"],
  [
    "nested-missing",
    "import {spawnSync} from 'node:child_process'; const r=spawnSync('assertledger-missing-child-9af14',[]); process.exit(r.status ?? 99);\n",
  ],
] as const) {
  test(`nonzero ${id} cannot earn target detection`, async () => {
    const receipt = await execute(completion, [{ id, content }]);
    const observation = receipt.observations.find((item) => item.worldId === id);
    assert.ok(observation);
    assert.notEqual(observation.state, "COMPLETED");
    assert.equal(receipt.decision, "OPEN");
  });
}

test("completed expected nonzero and swallowed semantic zero remain distinguishable", async () => {
  const receipt = await execute(completion, [{ id: "swallow", content: "process.exit(0);\n" }]);
  assert.equal(receipt.decision, "QUALIFIED");
  assert.equal(receipt.observations[0]?.facts.commandOutcome, "EXPECTED_FAILURE");
  assert.equal(
    receipt.observations.find((item) => item.worldId === "swallow")?.facts.commandOutcome,
    "PASS",
  );
});

const yaml = (extra = "", nesting = false) =>
  nesting
    ? `pipelines:\n  pull-requests:\n    '**':\n      - stage:\n          name: Mandatory stage\n${extra}          steps:\n            - parallel:\n                steps:\n                  - step:\n                      name: Gate\n                      script: [bun wrapper.mjs]\n`
    : `pipelines:\n  pull-requests:\n    '**':\n      - step:\n          name: Gate\n${extra}          script: [bun wrapper.mjs]\n`;
const route = {
  "pull-requests:**": [
    {
      name: "Gate",
      commands: ["bun wrapper.mjs"],
      ancestry: [
        { kind: "route", route: "pull-requests:**" },
        {
          kind: "step",
          index: 0,
          configuration: { name: "Gate", condition: null, trigger: "automatic" },
        },
      ],
    },
  ],
};

test("real CI parser detects conditional and manual gates while commands stay unchanged", async () => {
  const receipt = await execute(
    yaml(),
    [
      {
        id: "conditional",
        content: yaml(
          "          condition:\n            changesets:\n              includePaths: ['never/**']\n",
        ),
      },
      { id: "manual", content: yaml("          trigger: manual\n") },
    ],
    "ci-config",
    route,
  );
  assert.equal(receipt.decision, "QUALIFIED");
  for (const observation of receipt.observations) assert.equal(observation.state, "COMPLETED");
  const conditional = receipt.observations.find((item) => item.worldId === "conditional");
  assert.ok(conditional);
  assert.notDeepEqual(conditional.facts.ciRoutes, route);
});

test("CI ancestry retains conditional stages and parallel groups", async () => {
  const receipt = await execute(
    yaml("          trigger: manual\n", true),
    [{ id: "automatic-stage", content: yaml("", true) }],
    "ci-config",
    {},
  );
  const routes = receipt.observations[0]?.facts.ciRoutes as Record<
    string,
    Array<{ ancestry: Array<{ kind: string; configuration?: Record<string, unknown> }> }>
  >;
  assert.deepEqual(
    routes["pull-requests:**"]?.[0]?.ancestry.map((item) => item.kind),
    ["route", "stage", "parallel", "step"],
  );
  assert.equal(routes["pull-requests:**"]?.[0]?.ancestry[1]?.configuration?.trigger, "manual");
});

test("unsupported CI execution keys are refused rather than silently discarded", async () => {
  const receipt = await execute(
    yaml(),
    [{ id: "unsupported", content: yaml("          unknown-execution-policy: never\n") }],
    "ci-config",
    route,
  );
  assert.equal(
    receipt.observations.find((item) => item.worldId === "unsupported")?.state,
    "COLLECTION_ERROR",
  );
  assert.equal(receipt.decision, "OPEN");
});
