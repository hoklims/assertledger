// Generates docs/sdk-surface-map.md from the built package and refuses any unclassified export.
// Usage: node scripts/sdk-surface-map.mjs <repository-root> <output.md>, after `pnpm build`.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root, output] = process.argv.slice(2);
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const rootModule = await load("dist/index.js");
const coreModule = await load("dist/core/index.js");
const bunModule = await load("integrations/bun/assertions.mjs");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

const kindOf = (value) =>
  typeof value === "function"
    ? /^class\s/.test(Function.prototype.toString.call(value))
      ? "class"
      : "function"
    : typeof value;
const rootNames = Object.keys(rootModule).sort();
const coreNames = new Set(Object.keys(coreModule));
for (const name of coreNames)
  if (!(name in rootModule)) throw new Error(`./core export ${name} missing from .`);
const methods = Object.getOwnPropertyNames(rootModule.AssertLedger.prototype).filter(
  (n) => n !== "constructor",
);
if (Object.getOwnPropertyNames(rootModule.TestForge.prototype).some((n) => n !== "constructor")) {
  throw new Error("TestForge declares its own methods");
}

// Schema names accepted by `schema` on each surface, read from the sources.
const cliSource = readFileSync(path.join(root, "src/cli.ts"), "utf8");
const cliSchema = cliSource.slice(cliSource.indexOf('case "schema"'));
const cliSchemaNames = new Set(
  [
    ...cliSchema.slice(0, cliSchema.indexOf("io.writeStderr")).matchAll(/name !== "([a-z0-9-]+)"/g),
  ].map((m) => m[1]),
);
const mcpSource = readFileSync(path.join(root, "src/mcp/index.ts"), "utf8");
const mcpSchema = mcpSource.slice(mcpSource.indexOf("const schemaInputSchema"));
const mcpSchemaNames = new Set(
  [...mcpSchema.slice(0, mcpSchema.indexOf("]")).matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]),
);
const mcpTools = new Set([...mcpSource.matchAll(/"(assertledger_[a-z0-9_]+)"/g)].map((m) => m[1]));

const classified = new Map();
const claim = (name, section) => {
  if (!(name in rootModule)) throw new Error(`${name} is not a runtime export of .`);
  if (classified.has(name))
    throw new Error(`${name} classified twice (${classified.get(name)}, ${section})`);
  classified.set(name, section);
};
const code = (value) => `\`${value}\``;
const ref = (name) => (coreNames.has(name) ? `${code(name)}†` : code(name));
const tool = (name) => {
  if (!mcpTools.has(name)) throw new Error(`unknown MCP tool ${name}`);
  return code(name);
};

// 1. SDK class methods. CLI and MCP columns are verified against the dispatch code by the caller.
const methodRows = [
  [
    "sealQualificationPlan",
    "`qualification-plan`",
    tool("assertledger_qualification_plan"),
    "equivalent",
    "",
  ],
  [
    "qualifyOrchestration",
    "`qualify --allow-unsafe-execution`",
    `${tool("assertledger_qualify")}‡`,
    "equivalent",
    "Only with `allowUnsafeExecution: true`, the one mode the SDK executes.",
  ],
  [
    "replayQualification",
    "`qualification-replay [--domain]`",
    tool("assertledger_qualification_replay"),
    "equivalent",
    "",
  ],
  [
    "admitQualificationCi",
    "`qualification-ci --observation`",
    tool("assertledger_qualification_ci"),
    "equivalent",
    "",
  ],
  ["explain", "`explain CODE… --json`", tool("assertledger_explain"), "equivalent", ""],
  ["analyze", "`analyze`", tool("assertledger_analyze"), "equivalent", ""],
  [
    "audit",
    "`audit [--verification-request] [--no-git]`",
    "—",
    "partial",
    "The `afterInitialInventory` callback has no CLI equivalent.",
  ],
  [
    "init",
    "`init`",
    "—",
    "partial",
    "The `afterEvidenceSnapshot` and `onLinkAssessment` callbacks have no CLI equivalent.",
  ],
  [
    "doctor",
    "`doctor [--framework] [--exclude]`",
    tool("assertledger_doctor"),
    "partial",
    "The `onLinkAssessment` callback has no CLI or MCP equivalent.",
  ],
  [
    "doctorRuntime",
    "`doctor --runtime --allow-unsafe-execution`",
    `${tool("assertledger_doctor_runtime")}‡`,
    "equivalent",
    "",
  ],
  [
    "verify",
    "`verify --allow-unsafe-execution` (v1 request)",
    `${tool("assertledger_verify")}‡`,
    "equivalent",
    "",
  ],
  [
    "verifyV2",
    "`verify` (v2 request)",
    "—",
    "equivalent",
    "Container runtime and transport through `--container-runtime` and `--container-transport`.",
  ],
  ["verifyV3", "`verify` (v3 request)", `${tool("assertledger_verify_v3")}‡`, "equivalent", ""],
  ["verifyV4", "`verify` (v4 request)", "—", "equivalent", ""],
  ["verifyV5", "`verify` (v5 request)", "—", "equivalent", ""],
  [
    "importWitness",
    "`import-witness --out`",
    "—",
    "equivalent",
    "Isolation through `--container-image`, `--allow-unsafe-execution` or `--allow-windows-native-execution`; allowlist through `--env`.",
  ],
  [
    "checkGitRegression",
    "`check --allow-unsafe-execution`",
    `${tool("assertledger_check")}‡`,
    "equivalent",
    "",
  ],
  ["checkGitRegressionV2", "`check --container-image`", "—", "equivalent", ""],
  ["replay", "`replay`", tool("assertledger_replay"), "equivalent", ""],
  ["profile", "`profile`", tool("assertledger_profile"), "equivalent", ""],
  ["replayProfile", "`profile-replay`", tool("assertledger_profile_replay"), "equivalent", ""],
  ["exportEvidence", "`export`", tool("assertledger_export"), "equivalent", ""],
  ["replayEvidenceExport", "`export-replay`", tool("assertledger_export_replay"), "equivalent", ""],
  ["providerManifest", "`provider`", tool("assertledger_provider"), "equivalent", ""],
  ["benchmark", "`benchmark`", tool("assertledger_benchmark"), "equivalent", ""],
  [
    "replayBenchmark",
    "`benchmark-replay`",
    tool("assertledger_benchmark_replay"),
    "equivalent",
    "",
  ],
  [
    "acquireBenchmark",
    "`benchmark-acquire --allow-unsafe-execution`",
    `${tool("assertledger_benchmark_acquire")}‡`,
    "equivalent",
    "",
  ],
  [
    "replayBenchmarkAcquisition",
    "`benchmark-acquire-replay`",
    tool("assertledger_benchmark_acquire_replay"),
    "equivalent",
    "",
  ],
  ["profileV2", "`profile-v2`", tool("assertledger_profile_v2"), "equivalent", ""],
  [
    "replayProfileV2",
    "`profile-v2-replay`",
    tool("assertledger_profile_v2_replay"),
    "equivalent",
    "",
  ],
  ["allocateCorpus", "`corpus-allocate`", tool("assertledger_corpus_allocate"), "equivalent", ""],
  [
    "replayCorpusAllocation",
    "`corpus-allocation-replay`",
    tool("assertledger_corpus_allocation_replay"),
    "equivalent",
    "",
  ],
  [
    "corpusExperiment",
    "—",
    "—",
    "none",
    "Creates an H3 experiment artifact; only its replay has a command.",
  ],
  ["replayCorpusExperiment", "`corpus-experiment-replay`", "—", "equivalent", ""],
  [
    "replayCorpusAllocationCommitment",
    "—",
    "—",
    "none",
    "Replayed only inside `corpus-experiment-replay`.",
  ],
  [
    "schema",
    "`schema NAME`",
    tool("assertledger_schema"),
    "equivalent",
    `MCP accepts ${mcpSchemaNames.size} of the ${cliSchemaNames.size} CLI names.`,
  ],
];
const listedMethods = methodRows.map((row) => row[0]);
if (JSON.stringify([...listedMethods].sort()) !== JSON.stringify([...methods].sort())) {
  throw new Error(`method rows ${listedMethods.length} != prototype ${methods.length}`);
}
claim("AssertLedger", "class");
claim("TestForge", "class");

// 2. Document contracts: one row per published schema file.
const schemaFiles = readdirSync(path.join(root, "schemas"))
  .filter((f) => f.endsWith(".json"))
  .sort();
const pascal = (base) =>
  base
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
const camel = (base) => pascal(base)[0].toLowerCase() + pascal(base).slice(1);
// A Zod refinement or transform anywhere in the schema tree is lost in the JSON Schema.
const hasRefinement = (schema, seen = new Set()) => {
  if (schema === null || typeof schema !== "object" || !schema._zod || seen.has(schema)) {
    return false;
  }
  seen.add(schema);
  const def = schema._zod.def;
  if ((def.checks ?? []).some((check) => check._zod.def.check === "custom")) return true;
  if (def.type === "custom" || def.type === "transform") return true;
  const children = [
    def.element,
    def.innerType,
    def.in,
    def.out,
    def.left,
    def.right,
    def.keyType,
    def.valueType,
    def.catchall,
    def.rest,
    ...(def.options ?? []),
    ...(def.items ?? []),
    ...Object.values(def.shape ?? {}),
  ];
  if (def.type === "lazy") children.push(def.getter());
  return children.some((child) => hasRefinement(child, seen));
};
// A parser adds checks unless its compiled body is exactly safeParse, throw, return.
const isPlainParser = (fn) =>
  /^function \w+\(value\) \{\s*const parsed = \w+\.safeParse\(value\);\s*if \(!parsed\.success\) \{\s*throw new ContractError\([^;]*\);\s*\}\s*return parsed\.data;\s*\}$/.test(
    Function.prototype.toString.call(fn),
  );
const contractRows = [];
const partialFiles = new Set();
for (const file of schemaFiles) {
  const match = /^([a-z0-9-]+)\.v(\d+)\.json$/.exec(file);
  if (!match) throw new Error(`unexpected schema file ${file}`);
  const [, base, major] = match;
  const suffix = major === "1" ? "" : `V${major}`;
  const candidates = [
    `${pascal(base)}${suffix}Schema`,
    `parse${pascal(base)}${suffix}`,
    `${camel(base)}${suffix}JsonSchema`,
  ];
  const exports = candidates.filter((name) => name in rootModule);
  for (const name of exports) claim(name, "contract");
  const commandName = major === "1" ? base : `${base}-v${major}`;
  const cli = cliSchemaNames.has(commandName) ? "yes" : "—";
  const mcp = mcpSchemaNames.has(commandName) ? "yes" : "—";
  const [schemaName, parserName] = candidates;
  if (!(schemaName in rootModule)) throw new Error(`no Zod schema for ${file}`);
  const notes = [];
  if (hasRefinement(rootModule[schemaName])) {
    notes.push(`${code(schemaName)} has refinements the JSON Schema cannot express.`);
  }
  if (parserName in rootModule && !isPlainParser(rootModule[parserName])) {
    notes.push(`${code(parserName)} enforces invariants beyond the schema.`);
  }
  const status = notes.length > 0 ? "partial" : "equivalent";
  if (status === "partial") partialFiles.add(file);
  const note = notes.join(" ");
  contractRows.push([`${code(file)}`, exports.map(ref).join(", ") || "—", cli, mcp, status, note]);
}
const versionedRows = [];
for (const name of rootNames.filter((n) => n.startsWith("parseVersioned"))) {
  const base = name
    .replace("parseVersioned", "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .toLowerCase();
  const files = schemaFiles.filter((f) => f.startsWith(`${base}.v`));
  claim(name, "versioned");
  versionedRows.push([
    ref(name),
    files.map(code).join(", ") || "none published",
    files.length === 0 || files.some((f) => partialFiles.has(f)) ? "partial" : "equivalent",
  ]);
}

// Document contracts with a parser but no file in schemas/.
const unpublishedNotes = {
  AgenticCorpusCase:
    "Read from corpus case files by `corpus-status`, the `corpus-evaluate-*` commands and provenance replay.",
  AgenticCorpusExperimentReceipt: "Read only inside `corpus-experiment-replay`.",
  AgenticCorpusExperimentStructuredResult: "Read only inside `corpus-experiment-replay`.",
  RuntimeDoctorResult:
    "Returned by `doctor --runtime`; `assertledger_doctor_runtime` declares it as its MCP output schema.",
  RuntimeDoctorResultV2: "Same, version 2.",
};
const unpublishedRows = [];
for (const name of rootNames.filter((n) => /^parse[A-Z]/.test(n) && !classified.has(n))) {
  const base = name.slice("parse".length);
  const note = unpublishedNotes[base];
  if (note === undefined) throw new Error(`no note for unpublished contract ${base}`);
  const exports = [name, `${base}Schema`].filter((n) => n in rootModule);
  for (const n of exports) claim(n, "unpublished");
  unpublishedRows.push([exports.map(ref).join(", "), "partial", note]);
}
if (unpublishedRows.length !== Object.keys(unpublishedNotes).length)
  throw new Error("stale unpublished notes");

// 3. Module functions that run a workflow or one of its steps.
const functionRows = [
  [
    "acquireAgenticBenchmark",
    "`benchmark-acquire`",
    "equivalent",
    "Same path as `acquireBenchmark`.",
  ],
  ["admitQualificationCi", "`qualification-ci`", "equivalent", ""],
  ["analyzeRepository", "`analyze`", "partial", "The command fixes `configuredExcludes: true`."],
  ["auditRepository", "`audit`", "partial", "As `audit`, without the callback."],
  ["createAgenticBenchmark", "`benchmark`", "equivalent", ""],
  ["createAgenticCorpusAllocation", "`corpus-allocate`", "equivalent", ""],
  ["createAgenticCorpusExperimentArtifact", "—", "none", "As `corpusExperiment`."],
  ["createAgenticProfile", "`profile`", "equivalent", "Conformance operation `CREATE_PROFILE_V1`."],
  ["createAgenticProfileV2", "`profile-v2`", "equivalent", ""],
  [
    "createAssertLedgerServer",
    "`mcp [--root] [--allow-unsafe-execution]`",
    "partial",
    "The process serves stdio only; no in-process server object.",
  ],
  ["createTestForgeServer", "`mcp`", "partial", "Alias of `createAssertLedgerServer`."],
  ["createEvidenceExport", "`export`", "equivalent", ""],
  [
    "createEvidenceProviderManifest",
    "`provider`",
    "partial",
    "The command describes this package only; arbitrary inputs are not accepted.",
  ],
  [
    "createQualificationReceipt",
    "`qualify`",
    "partial",
    "Reached only as the last step of an executed qualification.",
  ],
  [
    "decideEvidence",
    "—",
    "none",
    "Conformance operation `DECIDE_EVIDENCE`; reached only inside `verify` and `check`.",
  ],
  ["doctorRepositoryRuntime", "`doctor --runtime`", "equivalent", ""],
  ["evaluateAgenticCorpusHoldout", "`corpus-evaluate-holdout`", "equivalent", ""],
  ["evaluateAgenticCorpusPublic", "`corpus-evaluate-public`", "equivalent", ""],
  ["explainReasonCodes", "`explain --json`", "equivalent", ""],
  ["renderDiagnostics", "`explain` (text)", "equivalent", ""],
  ["initializeRepository", "`init`", "partial", "As `init`, without the callbacks."],
  ["inspectAgenticCorpus", "`corpus-status`", "equivalent", ""],
  ["qualifyGitRegression", "`check --allow-unsafe-execution`", "equivalent", ""],
  ["qualifyOrchestration", "`qualify`", "equivalent", ""],
  [
    "replayAgenticBenchmark",
    "`benchmark-replay`",
    "equivalent",
    "Conformance operation `REPLAY_BENCHMARK_V1`.",
  ],
  ["replayAgenticBenchmarkAcquisition", "`benchmark-acquire-replay`", "equivalent", ""],
  ["replayAgenticCorpusAllocation", "`corpus-allocation-replay`", "equivalent", ""],
  [
    "replayAgenticCorpusAllocationCommitment",
    "—",
    "none",
    "As `replayCorpusAllocationCommitment`.",
  ],
  ["replayAgenticCorpusExperimentArtifact", "`corpus-experiment-replay`", "equivalent", ""],
  [
    "replayAgenticCorpusExperimentPlan",
    "—",
    "none",
    "Reached only inside `corpus-experiment-replay`.",
  ],
  ["replayAgenticCorpusProvenance", "—", "none", "Reached only inside `corpus-experiment-replay`."],
  ["replayAgenticProfile", "`profile-replay`", "equivalent", ""],
  ["replayAgenticProfileV2", "`profile-v2-replay`", "equivalent", ""],
  ["replayEvidenceExport", "`export-replay`", "equivalent", ""],
  ["replayEvidenceManifest", "`replay`", "equivalent", "Conformance operation `REPLAY_EVIDENCE`."],
  ["replayQualificationReceipt", "`qualification-replay`", "equivalent", ""],
  ["sealQualificationPlan", "`qualification-plan`", "equivalent", ""],
  ["verifyCampaign", "`verify`", "equivalent", ""],
  [
    "verifyManifestIntegrity",
    "`replay`",
    "partial",
    "Its digest checks are fields of the `replay` result.",
  ],
  ["verifyDecisionDigest", "`replay`", "partial", "`decisionDigestValid` in the `replay` result."],
  [
    "verifyQualificationCiObservation",
    "`qualify`",
    "partial",
    "Reached only inside receipt creation.",
  ],
  [
    "verifyAgenticCorpusAllocationCommitmentSignatures",
    "—",
    "none",
    "Reached only inside `corpus-experiment-replay`.",
  ],
  [
    "resolveAgenticCorpusExperimentEvidence",
    "—",
    "none",
    "Reached only inside `corpus-experiment-replay`.",
  ],
  ["selectCandidates", "—", "none", "Reached only inside `decideEvidence`."],
  ["sealManifestArtifact", "—", "none", "Reached only inside evidence-producing commands."],
  ["canonicalize", "—", "none", "Conformance operation `CANONICALIZE`."],
  ["sha256Canonical", "—", "none", ""],
  ["runProcess", "—", "none", "Engine process runner."],
];
for (const [name] of functionRows) claim(name, "function");

// 4. Digest and binding helpers, and utilities: no equivalent, grouped.
const helperPattern =
  /(Digest|SigningBytes|Projection|Binding)$|^(portablePathKey|assertSafeRelativePath|quoteRepositoryEntry|isRepositoryExcludeName|benchmarkCacheDirectoryKey|renderRepositoryLinkRefusal)$/;
const helpers = rootNames.filter(
  (n) => !classified.has(n) && kindOf(rootModule[n]) === "function" && helperPattern.test(n),
);
for (const name of helpers) claim(name, "helper");

// 5. Error classes.
const errors = rootNames.filter((n) => !classified.has(n) && kindOf(rootModule[n]) === "class");
for (const name of errors) claim(name, "error");

// 6. String constants: equivalent only when the value appears in a published schema.
const schemaText = schemaFiles
  .map((f) => readFileSync(path.join(root, "schemas", f), "utf8"))
  .join("\n");
const constantRows = [];
for (const name of rootNames.filter(
  (n) => !classified.has(n) && typeof rootModule[n] === "string",
)) {
  claim(name, "constant");
  const value = rootModule[name];
  const published = schemaText.includes(JSON.stringify(value));
  constantRows.push([
    ref(name),
    code(value),
    published ? "equivalent" : "none",
    published
      ? "The value appears in a published schema."
      : "The value appears in no published schema.",
  ]);
}

// 7. Remaining Zod objects and data constants: components of published schemas.
const components = rootNames.filter((n) => !classified.has(n) && typeof rootModule[n] === "object");
for (const name of components) claim(name, "component");
const standaloneComponents = [
  ["DiagnosticReportSchema", "output of `explain --json`"],
  ["QualificationExpectedDomainSchema", "input of `qualification-replay --domain`"],
  ["QualificationCiObservationSchema", "input of `qualification-ci --observation`"],
];
for (const [name] of standaloneComponents)
  if (!components.includes(name)) throw new Error(`${name} is not a component`);

const unclassified = rootNames.filter((n) => !classified.has(n));
if (unclassified.length > 0) throw new Error(`unclassified exports: ${unclassified.join(", ")}`);
const bunNames = Object.keys(bunModule).sort();
if (JSON.stringify(bunNames) !== JSON.stringify(["assertSame", "isAssertSameFailure"])) {
  throw new Error(`unexpected ./bun exports: ${bunNames.join(", ")}`);
}

const table = (header, rows) =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
const count = (rows, column, value) => rows.filter((r) => r[column] === value).length;
const methodNone = methodRows.filter((r) => r[3] === "none").map((r) => code(r[0]));
const functionNone = functionRows.filter((r) => r[2] === "none").map((r) => code(r[0]));

const doc = `# SDK surface map

[ADR 0003](decisions/0003-retire-public-javascript-api.md) retires the JavaScript API in 3.0.0 and
requires, before the last 2.x release, a mapping from every public SDK method to a CLI command or an
MCP tool. This page is that mapping, measured on version ${version}. A row with status \`none\` has
no equivalent today.

## Scope

The JavaScript API is the three package exports and every runtime value they expose:

| Export | Runtime values | Content |
| --- | --- | --- |
| \`.\` | ${rootNames.length} | Everything below |
| \`./core\` | ${coreNames.size} | A subset of \`.\`, marked † in this page |
| \`./bun\` | ${bunNames.length} | \`assertSame\`, \`isAssertSameFailure\` |

Type-only exports have no runtime value and are not listed. Every runtime value of \`.\` appears in
exactly one section below.

Statuses:

- \`equivalent\`: a CLI command, an MCP tool or a published schema accepts the same inputs and returns
  the same document.
- \`partial\`: the behavior is reachable, with the restriction given in the note.
- \`none\`: no command, tool or schema reaches it on its own inputs.

‡ The MCP tool exists only when the server runs with \`--allow-unsafe-execution\`.

## \`AssertLedger\` methods

\`TestForge\` is a subclass that declares no method of its own; its rows are the same.

${table(
  ["Method", "CLI", "MCP", "Status", "Note"],
  methodRows.map(([m, ...rest]) => [code(m), ...rest]),
)}

${methodRows.length} methods: ${count(methodRows, 3, "equivalent")} equivalent, ${count(methodRows, 3, "partial")} partial, ${count(methodRows, 3, "none")} none (${methodNone.join(", ")}).

## Document contracts

Each published schema in \`schemas/\` is the JSON Schema of the Zod schema exported for that
document. \`schema NAME\` prints it from the CLI and the MCP server when the name is accepted there;
the file ships in the package either way.

A row is \`equivalent\` only when validating against the file accepts exactly what the exports
accept. It is \`partial\` when the Zod schema holds a refinement, or when the parser runs checks
after the schema (identifier uniqueness, digest bindings, cross-field consistency). Those checks
reach a CLI or MCP user only through the command that parses the document.

${table(["Published schema", "Exports", "CLI `schema`", "MCP `schema`", "Status", "Note"], contractRows)}

${contractRows.length} published schemas: ${count(contractRows, 4, "equivalent")} equivalent, ${count(contractRows, 4, "partial")} partial.

Versioned parsers dispatch on \`schemaVersion\` to the parsers above:

${table(["Export", "Published schemas", "Status"], versionedRows)}

Document contracts that have a parser but no published schema. A command or tool produces or
reads the document; no file in \`schemas/\` describes it:

${table(["Exports", "Status", "Note"], unpublishedRows)}

## Workflow functions

Module functions that run a command, or one step of it.

${table(
  ["Function", "Equivalent", "Status", "Note"],
  functionRows.map(([n, ...rest]) => [ref(n), ...rest]),
)}

${functionRows.length} functions: ${count(functionRows, 2, "equivalent")} equivalent, ${count(functionRows, 2, "partial")} partial, ${count(functionRows, 2, "none")} none.

## Digest helpers and utilities

Status \`none\` for all ${helpers.length}. They compute a digest, signing bytes or a binding that commands embed in
their documents, or serve the engine internally:

${helpers.map(ref).join(", ")}.

## Error classes

Status \`partial\` for all ${errors.length}. A command reports the error as an exit code and a message on standard
error, an MCP tool as a JSON-RPC error; neither exposes the class. Whether those messages are
contractual is decided in D5.

${errors.map(code).join(", ")}.

## Constants

${table(["Constant", "Value", "Status", "Note"], constantRows)}

## Schema components

Status \`partial\` for all ${components.length}. Zod schemas and data constants for documents or parts of documents;
none has a file in \`schemas/\`. Three describe a whole command input or output, and the MCP server
declares them in its tool schemas: ${standaloneComponents.map(([n, role]) => `${code(n)} (${role})`).join(", ")}.

${components.map(ref).join(", ")}.

## \`./bun\`

| Export | Status | Note |
| --- | --- | --- |
| \`assertSame\` | none | Replaced by Bun's native \`expect\` matchers ([ADR 0004](decisions/0004-bun-native-matcher-attribution.md)). |
| \`isAssertSameFailure\` | none | Same. |

## Gaps

ADR 0003 blocks the last 2.x release on a public method without an equivalent. These have status
\`none\`; each needs a command, or a decision that removes it from the public surface:

- methods: ${methodNone.join(", ")};
- workflow functions: ${functionNone.join(", ")};
- the ${helpers.length} digest helpers and utilities, and \`./bun\`.

The scope of \`assertledger core <op>\` is decided in D11; the conformance bundle names six
operations, of which \`CANONICALIZE\` and \`DECIDE_EVIDENCE\` have no command today. Closing the gaps
is E10.

## Regenerating

This page is generated from the built package. It refuses an export it cannot classify:

\`\`\`sh
pnpm build
node scripts/sdk-surface-map.mjs . docs/sdk-surface-map.md
\`\`\`
`;
writeFileSync(output, doc);
console.log(
  `methods ${methodRows.length}, contracts ${contractRows.length}, versioned ${versionedRows.length}, unpublished ${unpublishedRows.length}, functions ${functionRows.length}, helpers ${helpers.length}, errors ${errors.length}, constants ${constantRows.length}, components ${components.length}, total ${classified.size}/${rootNames.length}`,
);
