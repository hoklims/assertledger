import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { QualificationPlan } from "../src/contracts/qualification.js";
import { sha256Canonical } from "../src/core/index.js";
import { sealQualificationPlan, replayQualificationReceipt } from "../src/core/qualification.js";
import {
  qualificationFileDigest,
  qualificationRepositoryDigest,
  qualifyOrchestration,
  qualificationMechanismDigest,
} from "../src/engine/qualification.js";

// The operator owns this manifest and oracle. Fixture fault overlays never select checks.
const args = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    if (separator < 0 || !argument.startsWith("--")) throw new Error("Use --name=value options");
    return [argument.slice(2, separator), argument.slice(separator + 1)];
  }),
);
const required = (key: string) => {
  const value = args[key];
  if (!value || !path.isAbsolute(value)) throw new Error(`--${key}=absolute-path is required`);
  return value;
};
const turbo = required("turbo");
const bun = required("bun");
const pnpm = required("pnpm");
const output = required("output");
const root = fileURLToPath(new URL("../examples/orchestration/workspace/", import.meta.url));
const sourceRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const outputRelative = path.relative(sourceRoot, path.resolve(output));
if (
  outputRelative === "" ||
  (!outputRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(outputRelative))
) {
  throw new Error("Qualification output must be outside the source repository");
}
const version = (executable: string, arguments_: string[] = ["--version"]) => {
  const result = spawnSync(executable, arguments_, { encoding: "utf8", timeout: 5000, cwd: root });
  if (result.status !== 0 || result.error) throw new Error(`Tool probe failed: ${executable}`);
  return result.stdout.trim().replace(/^v/u, "");
};
if (version(turbo) !== "2.11.7" || version(bun) !== "1.4.2" || version(pnpm) !== "12.9.1")
  throw new Error("This profile requires Turbo 2.11.7 / Bun 1.4.2 / pnpm 12.9.1");
// Turbo launches package scripts via its pinned package manager. Bind that script below.
process.env.PATH = `${path.dirname(bun)}${path.delimiter}${path.dirname(pnpm)}${path.delimiter}${process.env.PATH ?? ""}`;
const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const fixture = (relative: string) => readFile(path.join(root, relative), "utf8");
const initialConfig = JSON.parse(await fixture("turbo.json"));
const leafManifest = JSON.parse(await fixture("packages/leaf/package.json"));
type Action = QualificationPlan["actions"][number];
const action = (
  id: string,
  adapter: Action["adapter"],
  executable: string,
  arguments_: string[],
  options: Partial<Action> = {},
): Action => ({
  id,
  adapter,
  executable,
  arguments: arguments_,
  environment: {
    PUBLIC_TURBO_EXECUTABLE: turbo,
    ...Object.fromEntries(
      ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA"].flatMap(
        (key) => (process.env[key] === undefined ? [] : [[key, process.env[key] as string]]),
      ),
    ),
  },
  prepareFiles: [],
  removePaths: [],
  observe: { trace: false, outputs: [], report: null },
  ...options,
});
const outputs = [
  "packages/app/dist/result.txt",
  "packages/app/dist/manifest.txt",
  "packages/leaf/dist/result.txt",
  "packages/leaf/dist/manifest.txt",
];
const tasks = ["@public/app#build", "@public/leaf#build"];
const turboArgs = [
  "run",
  "build",
  "--filter=@public/app...",
  "--cache=local:rw",
  "--cache-dir={cache}",
  "--summarize",
];
const actions = [
  action("package-manager", "command", pnpm, ["--version"]),
  action("prepare-workspace", "command", pnpm, [
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-frozen-lockfile",
  ]),
  action("shape-tests", "node-test", process.execPath, ["command-shape.test.mjs"]),
  action("native-tests", "bun-native", bun, ["native.test.ts"]),
  action("cold", "turbo", turbo, turboArgs, { observe: { trace: true, outputs, report: null } }),
  action("warm", "turbo", turbo, turboArgs, {
    removePaths: ["packages/app/dist", "packages/leaf/dist"],
    observe: { trace: true, outputs, report: null },
  }),
  action("invalidate", "turbo", turbo, turboArgs, {
    prepareFiles: [{ path: "packages/leaf/verdict.txt", content: "changed\n" }],
    observe: { trace: true, outputs, report: null },
  }),
  action(
    "uncached-cold",
    "turbo",
    turbo,
    ["run", "check", "--cache=local:rw", "--cache-dir={cache}", "--summarize"],
    { observe: { trace: true, outputs: [], report: null } },
  ),
  action(
    "uncached-warm",
    "turbo",
    turbo,
    ["run", "check", "--cache=local:rw", "--cache-dir={cache}", "--summarize"],
    { observe: { trace: true, outputs: [], report: null } },
  ),
  action("seed", "command", bun, ["wrapper.mjs", "seed"]),
  action("propagate", "command", bun, ["wrapper.mjs"], {
    observe: { trace: true, outputs: [], report: null },
  }),
  action("ci-route", "ci-config", bun, ["bitbucket-pipelines.yml"]),
];
type Obligation = QualificationPlan["obligations"][number];
const obligation = (
  id: string,
  kind: Obligation["kind"],
  checks: Obligation["checks"],
  suiteIds: string[] = [],
): Obligation => ({
  id,
  kind,
  required: true,
  suiteIds,
  checks,
  limits: [
    "Synthetic public workspace only; this is not hosted Bitbucket execution or private consumer qualification.",
  ],
});
const check = (
  id: string,
  actionId: string,
  field: string,
  expected: Obligation["checks"][number]["expected"],
) => ({ id, actionId, field, expected });
const initialOutputs = Object.fromEntries(
  outputs.map((file) => [
    file,
    digest(file.endsWith("manifest.txt") ? "required-output\n" : "initial\n"),
  ]),
);
const invalidatedOutputs = {
  ...initialOutputs,
  "packages/leaf/dist/result.txt": digest("changed\n"),
};
const obligations = [
  obligation(
    "extracted-tests",
    "tests",
    [
      check("shape-pass", "shape-tests", "testOutcome", "PASS"),
      check("shape-count", "shape-tests", "testsDiscovered", 2),
    ],
    ["command-shape"],
  ),
  obligation(
    "bun-native",
    "tests",
    [
      check("bun-pass", "native-tests", "testOutcome", "PASS"),
      check("bun-count", "native-tests", "testsDiscovered", 1),
    ],
    ["native-bun"],
  ),
  obligation("selection", "selection", [
    check("workspace-prepared", "prepare-workspace", "exitCode", 0),
    check("selected", "cold", "selectedTasks", tasks),
  ]),
  obligation("cache-input", "cache", [
    check("cold-exit", "cold", "exitCode", 0),
    check("warm-exit", "warm", "exitCode", 0),
    check("invalidation-exit", "invalidate", "exitCode", 0),
    check("cold-execution", "cold", "executedTasks", tasks),
    check("cold-outputs", "cold", "outputs", initialOutputs),
    check("warm-no-execution", "warm", "executedTasks", []),
    check("warm-restoration", "warm", "outputs", initialOutputs),
    check("invalidation-execution", "invalidate", "executedTasks", tasks),
    check("invalidation-outputs", "invalidate", "outputs", invalidatedOutputs),
  ]),
  obligation("cache-disabled", "cache", [
    check("uncached-cold-exit", "uncached-cold", "exitCode", 0),
    check("uncached-warm-exit", "uncached-warm", "exitCode", 0),
    check("uncached-first", "uncached-cold", "executedTasks", [
      "@public/app#check",
      "@public/leaf#check",
    ]),
    check("uncached-again", "uncached-warm", "executedTasks", [
      "@public/app#check",
      "@public/leaf#check",
    ]),
  ]),
  obligation("propagation", "propagation", [
    check("terminal-exit", "propagate", "exitCode", 7),
    check("terminal-events", "propagate", "events", [
      "terminal:start",
      "orchestrator:start",
      "mandatory-stage:start",
      "mandatory-stage:finish",
      "@public/leaf#fail:start",
      "@public/leaf#fail:fail",
      "orchestrator:fail",
      "terminal:fail",
    ]),
  ]),
  obligation("ci-routing", "ci-config", [
    check("required-route", "ci-route", "ciRoutes", {
      "pull-requests:**": [
        {
          name: "Public qualification gate",
          commands: ["bun wrapper.mjs"],
          ancestry: [
            { kind: "route", route: "pull-requests:**" },
            {
              kind: "step",
              index: 0,
              configuration: {
                name: "Public qualification gate",
                condition: null,
                trigger: "automatic",
              },
            },
          ],
        },
      ],
    }),
  ]),
];
type World = QualificationPlan["worlds"][number];
const fault = (
  id: string,
  files: World["files"],
  obligationId: string,
  checkIds: string[],
): World => ({ id, kind: "TARGET", files, discriminants: [{ obligationId, checkIds }] });
const config = (update: (value: typeof initialConfig) => void) => {
  const value = structuredClone(initialConfig);
  update(value);
  return { path: "turbo.json", content: JSON.stringify(value) };
};
const wrapperFault = (id: string, key: string) =>
  fault(id, [{ path: "faults.json", content: JSON.stringify({ [key]: true }) }], "propagation", [
    "terminal-exit",
    "terminal-events",
  ]);
const worlds: World[] = [
  { id: "reference", kind: "REFERENCE", files: [], discriminants: [] },
  {
    id: "neutral",
    kind: "NEUTRAL",
    files: [{ path: "harmless-note.txt", content: "A documentation-only neutral change.\n" }],
    discriminants: [],
  },
  fault(
    "shape-assertion",
    [
      {
        path: "commands.mjs",
        content: (await fixture("commands.mjs")).replace(
          '"--filter=@public/app..."',
          '"--filter=@public/leaf..."',
        ),
      },
    ],
    "extracted-tests",
    ["shape-pass"],
  ),
  fault(
    "bun-assertion",
    [
      {
        path: "native.test.ts",
        content: (await fixture("native.test.ts")).replace("toBe(4)", "toBe(5)"),
      },
    ],
    "bun-native",
    ["bun-pass"],
  ),
  fault(
    "wrong-selection",
    [
      {
        path: "packages/app/package.json",
        content: JSON.stringify({
          ...JSON.parse(await fixture("packages/app/package.json")),
          dependencies: {},
        }),
      },
    ],
    "selection",
    ["selected"],
  ),
  fault(
    "leaf-command-disconnected",
    [
      {
        path: "packages/leaf/package.json",
        content: JSON.stringify({
          ...leafManifest,
          scripts: { ...leafManifest.scripts, fail: leafManifest.scripts.check },
        }),
      },
    ],
    "propagation",
    ["terminal-exit", "terminal-events"],
  ),
  fault(
    "forgotten-input",
    [
      config((value) => {
        value.tasks.build.inputs = [
          "$TURBO_DEFAULT$",
          "$TURBO_ROOT$/task.mjs",
          "$TURBO_ROOT$/completion.mjs",
          "!dist/**",
          "!.turbo/**",
          "!node_modules/**",
          "!verdict.txt",
        ];
      }),
    ],
    "cache-input",
    ["invalidation-execution", "invalidation-outputs"],
  ),
  fault(
    "incomplete-restoration",
    [
      config((value) => {
        value.tasks.build.outputs = ["dist/result.txt"];
      }),
    ],
    "cache-input",
    ["warm-restoration", "invalidation-outputs"],
  ),
  fault(
    "cache-disabled-ignored",
    [
      config((value) => {
        value.tasks.check.cache = true;
      }),
    ],
    "cache-disabled",
    ["uncached-again"],
  ),
  wrapperFault("failure-swallowed", "swallow"),
  wrapperFault("mandatory-stage-omitted", "omitStage"),
  wrapperFault("empty-selection", "emptySelection"),
  wrapperFault("trailing-command-mask", "trailingMask"),
  wrapperFault("stale-success", "staleResult"),
  fault(
    "ci-gate-disconnected",
    [
      {
        path: "bitbucket-pipelines.yml",
        content:
          "pipelines:\n  pull-requests:\n    '**':\n      - step:\n          name: Public qualification gate\n          script:\n            - echo skipped\n",
      },
    ],
    "ci-routing",
    ["required-route"],
  ),
  ...(
    [
      [
        "ci-gate-conditional",
        "          condition:\n            changesets:\n              includePaths: ['never/**']\n",
      ],
      ["ci-gate-manual", "          trigger: manual\n"],
    ] as const
  ).map(([id, execution]) =>
    fault(
      id,
      [
        {
          path: "bitbucket-pipelines.yml",
          content: `pipelines:\n  pull-requests:\n    '**':\n      - step:\n          name: Public qualification gate\n${execution}          script:\n            - bun wrapper.mjs\n`,
        },
      ],
      "ci-routing",
      ["required-route"],
    ),
  ),
];
const tools: QualificationPlan["tools"] = await Promise.all(
  (
    [
      ["turbo", turbo],
      ["bun", bun],
      ["node", process.execPath],
    ] as const
  ).map(async ([id, executable]) => ({
    id,
    version: version(executable),
    digest: await qualificationFileDigest(executable),
    identityPath: executable,
  })),
);
tools.push({
  id: "pnpm",
  version: "12.9.1",
  digest: await qualificationFileDigest(pnpm),
  identityPath: pnpm,
});
const sealed = sealQualificationPlan({
  schemaVersion: "1.0.0",
  profileId: "public-turbo-orchestration-2.11.7-bun-1.4.2",
  subject: {
    commit: args.commit ?? "public-fixture-v1",
    baseCommit: args.base ?? "public-fixture-v1",
    candidateDigest: sha256Canonical([]),
    inputDigest: await qualificationRepositoryDigest(root),
  },
  tools,
  suites: [
    { id: "command-shape", files: ["command-shape.test.mjs"], extraction: "COMPLETE" },
    { id: "native-bun", files: ["native.test.ts"], extraction: "COMPLETE" },
  ],
  obligations,
  actions,
  worlds,
  requiredAttempts: 2,
  timeoutMs: 60000,
  maximumOutputBytes: 1024 * 1024,
  isolation: { kind: "trusted-local", acknowledgedUnsafeExecution: true },
  allowedCandidatePaths: [],
});
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(sealed, null, 2)}\n`);
const receipt = await qualifyOrchestration(
  { root, ...sealed, candidate: { files: [] } },
  { allowUnsafeExecution: true },
);
const replay = replayQualificationReceipt(receipt, {
  planDigest: sealed.planDigest,
  ...sealed.plan.subject,
  mechanismDigest: await qualificationMechanismDigest(),
});
await writeFile(
  path.join(output, "domain.json"),
  `${JSON.stringify({ planDigest: sealed.planDigest, ...sealed.plan.subject, mechanismDigest: await qualificationMechanismDigest() }, null, 2)}\n`,
);
await writeFile(path.join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
await writeFile(path.join(output, "replay.json"), `${JSON.stringify(replay, null, 2)}\n`);
await writeFile(
  path.join(output, "matrix.json"),
  `${JSON.stringify(receipt.assessments, null, 2)}\n`,
);
const orchestrationWorlds = sealed.plan.worlds.filter(
  (world) => world.kind === "TARGET" && !["shape-assertion", "bun-assertion"].includes(world.id),
);
const incident = orchestrationWorlds.map((world) => {
  const observations = receipt.observations.filter(
    (observation) => observation.worldId === world.id && observation.actionId === "shape-tests",
  );
  return {
    worldId: world.id,
    extractedCommandShapeTestsPass:
      observations.length === sealed.plan.requiredAttempts &&
      observations.every(
        (observation) =>
          observation.state === "COMPLETED" && observation.facts.testOutcome === "PASS",
      ),
    requiredDiscriminants: world.discriminants,
  };
});
await writeFile(
  path.join(output, "incident-reproduction.json"),
  `${JSON.stringify({ incident: "public-911-evidence-gap", consumerReady: false, worlds: incident }, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    profileId: sealed.plan.profileId,
    decision: receipt.decision,
    replay,
    assessments: receipt.assessments,
  }),
);
if (
  receipt.decision !== "QUALIFIED" ||
  !replay.valid ||
  incident.some((world) => !world.extractedCommandShapeTestsPass)
)
  process.exitCode = 1;
