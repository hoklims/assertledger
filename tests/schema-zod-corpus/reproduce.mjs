import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import Ajv2020 from "ajv/dist/2020.js";

assert.ok(
  process.argv[2] && process.argv[3],
  "Usage: reproduce.mjs <repository-root> <output-directory>",
);
const root = path.resolve(process.argv[2]);
const lab = path.resolve(process.argv[3]);
assert.notEqual(lab, root);
fs.mkdirSync(lab, { recursive: true });
const load = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const sha = (x) => createHash("sha256").update(x).digest("hex");
const contracts = {
  ...(await import(pathToFileURL(path.join(root, "src/contracts/index.ts")))),
  ...(await import(pathToFileURL(path.join(root, "src/contracts/qualification.ts")))),
};
const core = await import(pathToFileURL(path.join(root, "src/core/index.ts")));
const qualification = await import(pathToFileURL(path.join(root, "src/core/qualification.ts")));
const sourceMap = fs.readFileSync(path.join(root, "docs/sdk-surface-map.md"), "utf8");
const registry = new Map();
for (const line of sourceMap.split("\n")) {
  const columns = line.split("|").map((x) => x.trim());
  if (!/^`[^`]+\.json`$/.test(columns[1] ?? "")) continue;
  const filename = columns[1].slice(1, -1);
  const names = [...columns[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
  const schemaName = names.find((x) => x.endsWith("Schema"));
  const parserName = names.find((x) => x.startsWith("parse"));
  assert.equal(typeof contracts[schemaName]?.safeParse, "function", filename);
  if (parserName) assert.equal(typeof contracts[parserName], "function", filename);
  registry.set(filename, { schemaName, parserName });
}
const options = {
  strict: true,
  allowUnionTypes: true,
  allErrors: true,
  unicodeRegExp: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  validateFormats: true,
};
const validators = new Map();
const schemaInventory = [];
for (const filename of fs
  .readdirSync(path.join(root, "schemas"))
  .filter((x) => x.endsWith(".json"))
  .sort()) {
  assert.ok(registry.has(filename), filename);
  const bytes = fs.readFileSync(path.join(root, "schemas", filename));
  const schema = JSON.parse(bytes);
  const validator = new Ajv2020(options).compile(schema);
  validators.set(filename, validator);
  schemaInventory.push({ filename, sha256: sha(bytes), ...registry.get(filename) });
}
const corpus = [];
const add = (id, family, filename, input, origin) => {
  assert.ok(validators.has(filename), filename);
  corpus.push({ id, family, filename, origin, input: JSON.parse(JSON.stringify(input)) });
};
const historical = load("tests/replay-corpus/corpus.json");
for (const entry of historical.entries) {
  let bytes = fs.readFileSync(path.join(root, entry.document));
  if (entry.document.endsWith(".gz")) bytes = gunzipSync(bytes);
  assert.equal(`sha256:${sha(bytes)}`, entry.sha256, entry.id);
  const document = JSON.parse(bytes);
  const filename =
    entry.kind === "evidence"
      ? `evidence-manifest.v${document.schemaVersion[0]}.json`
      : "qualification-receipt.v1.json";
  add(entry.id, "historical-document", filename, document, entry.document);
  if (entry.kind === "qualification")
    add(
      `${entry.id}-plan`,
      "historical-plan",
      "qualification-plan.v1.json",
      document.plan,
      `${entry.document}#/plan`,
    );
  const request = entry.input && path.join(entry.input, "request.json");
  if (request && fs.existsSync(path.join(root, request))) {
    const input = load(request);
    const schema =
      entry.kind === "evidence"
        ? `verification-request.v${input.schemaVersion[0]}.json`
        : "qualification-execution-request.v1.json";
    add(`${entry.id}-request`, "historical-request", schema, input, request);
  }
}
const digest = (c) => `sha256:${c.repeat(64)}`;
add(
  "trust-policy",
  "synthetic-control",
  "agentic-corpus-trust-policy.v1.json",
  {
    schemaVersion: "1.0.0",
    policyId: "e3",
    policyDigest: digest("a"),
    keys: ["b", "c"].map((c, i) => ({
      keyId: digest(c),
      subjectId: i ? "reviewer" : "author",
      roles: [i ? "REVIEWER" : "AUTHOR"],
      publicKey: { algorithm: "Ed25519", format: "SPKI_DER_BASE64URL", data: "AA" },
    })),
    sources: [
      {
        sourceId: "source",
        sourceIdentityDigest: digest("d"),
        authorizedAuthorSubjectIds: ["author"],
        authorizedReviewerSubjectIds: ["reviewer"],
      },
    ],
  },
  "synthetic:shape-only; not a cryptographically valid trust root",
);
add(
  "replay-result",
  "synthetic-control",
  "replay-result.v1.json",
  {
    valid: true,
    schemaValid: true,
    decisionDigestValid: true,
    artifactDigestValid: true,
    decisionSemanticsValid: true,
  },
  "synthetic",
);
add(
  "allocation-request",
  "synthetic-control",
  "agentic-corpus-allocation-request.v1.json",
  {
    schemaVersion: "1.0.0",
    allocationId: "e3",
    seedDigest: digest("a"),
    strata: [
      {
        sourceId: "source",
        sourceIdentityDigest: digest("b"),
        calibrationCount: 1,
        caseIds: ["case-a", "case-b"],
      },
    ],
  },
  "synthetic; based on tests/corpus-allocation.test.ts:37",
);
const bases = [...corpus];
const mutate = (baseId, suffix, family, change) => {
  const base = bases.find((x) => x.id === baseId);
  assert.ok(base, baseId);
  const value = structuredClone(base.input);
  change(value);
  add(`${baseId}/${suffix}`, family, base.filename, value, base.id);
};
for (const base of bases) {
  add(`${base.id}/null`, "structural-reject", base.filename, null, base.id);
  mutate(base.id, "unknown-field", "structural-reject", (v) => {
    v.e3Unknown = true;
  });
  mutate(base.id, "missing-field", "structural-reject", (v) => {
    delete v[Object.keys(v)[0]];
  });
}
const requestId = "evidence-v1-request";
mutate(requestId, "duplicate-world", "post-parse", (v) => {
  v.worlds[1].id = v.worlds[0].id;
});
mutate(requestId, "duplicate-candidate", "post-parse", (v) => {
  v.candidates[1].id = v.candidates[0].id;
});
mutate(requestId, "target-weight-zero", "post-parse", (v) => {
  v.worlds.find((x) => x.kind === "TARGET").weight = 0;
});
mutate(requestId, "missing-neutral", "post-parse", (v) => {
  v.worlds = v.worlds.filter((x) => x.kind !== "NEUTRAL");
});
mutate(requestId, "execution-budget", "post-parse", (v) => {
  v.budgets.maximumExecutions = 1;
});
mutate(requestId, "utf8-byte-budget", "post-parse", (v) => {
  for (const world of v.worlds) for (const file of world.files) file.content = "";
  v.worlds[1].files[0].content = "é";
  v.budgets.maximumWorldOverlayBytes = 1;
});
mutate(requestId, "unsafe-outcome", "structural-reject", (v) => {
  v.policy.acceptedTargetOutcomes = ["TIMEOUT"];
});
mutate(requestId, "reserved-env", "structural-reject", (v) => {
  v.isolation.environmentAllowlist = ["NODE_OPTIONS"];
});
for (const [name, value] of [
  ["ascii-512", "a".repeat(512)],
  ["ascii-513", "a".repeat(513)],
  ["astral-256", "😀".repeat(256)],
  ["astral-257", "😀".repeat(257)],
  ["astral-512", "😀".repeat(512)],
  ["astral-513", "😀".repeat(513)],
  ["combining-256", "e\u0301".repeat(256)],
  ["combining-257", "e\u0301".repeat(257)],
]) {
  mutate(requestId, name, "unicode-length", (v) => {
    v.candidates[0].files[0].path = value;
  });
}
for (const [name, value] of [
  ["int-string", "1"],
  ["fraction", 1.5],
  ["zero", 0],
  ["max-safe", Number.MAX_SAFE_INTEGER],
  ["unsafe-int", Number.MAX_SAFE_INTEGER + 1],
  ["enough-executions", 18],
  ["short-executions", 17],
]) {
  mutate(requestId, name, "numeric", (v) => {
    v.budgets.maximumExecutions = value;
  });
}
mutate(requestId, "null-optional", "structural-reject", (v) => {
  v.adapter.extraArguments = null;
});
mutate(requestId, "empty-optional-array", "structural-accept", (v) => {
  v.adapter.extraArguments = [];
});
const planId = "qualification-2.1.0-node-test-plan";
for (const value of [
  "../escape",
  "/absolute",
  "a\\b",
  "C:/a",
  "a//b",
  "./a",
  "a/../b",
  "a.",
  "NUL.txt",
  "con/a",
  "a\u0000b",
]) {
  mutate(planId, `relative-path-${Buffer.from(value).toString("hex")}`, "refinement-path", (v) => {
    v.allowedCandidatePaths = [value];
  });
}
for (const value of ["identity", "/tmp/e3\nidentity"]) {
  mutate(planId, `identity-${Buffer.from(value).toString("hex")}`, "refinement-identity", (v) => {
    v.tools[0].identityPath = value;
  });
}
for (const value of ["HOME", "NODE_OPTIONS", "ASSERTLEDGER_E3"]) {
  mutate(planId, `env-${value}`, "refinement-env", (v) => {
    v.actions[0].environment = { [value]: "x" };
  });
}
mutate(planId, "unknown-action", "post-parse", (v) => {
  v.obligations[0].checks[0].actionId = "unknown";
});
mutate(planId, "case-insensitive-tool", "post-parse", (v) => {
  v.tools.push({ ...v.tools[0], id: v.tools[0].id.toUpperCase() });
});
mutate("qualification-2.1.0-node-test", "runtime-relative", "refinement-runtime", (v) => {
  Object.values(v.provenance.runtime.tools)[0].executable = "relative";
});
mutate(
  "qualification-2.1.0-node-test-request",
  "candidate-relative-path",
  "refinement-nested",
  (v) => {
    v.candidate.files = [{ path: "../escape", content: "" }];
  },
);
mutate("qualification-2.1.0-node-test", "plan-relative-path", "refinement-nested", (v) => {
  v.plan.allowedCandidatePaths = ["../escape"];
});
mutate("allocation-request", "case-collision", "post-parse", (v) => {
  v.strata[0].caseIds = ["case-a", "CASE-A"];
});
mutate("allocation-request", "empty-holdout", "post-parse", (v) => {
  v.strata[0].calibrationCount = 2;
});
mutate("trust-policy", "duplicate-role", "post-parse", (v) => {
  v.keys[0].roles = ["AUTHOR", "AUTHOR"];
});
mutate("trust-policy", "duplicate-key", "post-parse", (v) => {
  v.keys[1].keyId = v.keys[0].keyId;
});
mutate("trust-policy", "duplicate-author", "post-parse", (v) => {
  v.sources[0].authorizedAuthorSubjectIds.push("author");
});
mutate("replay-result", "inconsistent", "post-parse", (v) => {
  v.valid = false;
});
mutate("evidence-v1", "unknown-world-reference", "post-parse", (v) => {
  v.observations[0].worldId = "unknown";
});
mutate("evidence-v1", "wrong-decision-digest", "replay-only", (v) => {
  v.decisionDigest = digest("0");
});
mutate("evidence-v1", "wrong-artifact-digest", "replay-only", (v) => {
  v.artifactDigest = digest("0");
});
const results = [];
for (const item of corpus) {
  const { schemaName, parserName } = registry.get(item.filename);
  const before = JSON.stringify(item.input);
  const jsonSchema = validators.get(item.filename)(item.input);
  const jsonErrors = structuredClone(validators.get(item.filename).errors);
  const zod = contracts[schemaName].safeParse(item.input);
  let parser = null;
  if (parserName) {
    try {
      contracts[parserName](item.input);
      parser = { accepted: true };
    } catch (error) {
      const expected =
        ["ContractError", "ZodError"].includes(error.constructor.name) ||
        (parserName === "parseQualificationPlan" &&
          error.constructor.name === "Error" &&
          /^(Duplicate |Unknown |Test obligation |Test suite |Reference and neutral worlds required|Only target |Target world |Target discriminant )/.test(
            error.message,
          ));
      if (!expected) throw error;
      parser = {
        accepted: false,
        type: error.constructor.name,
        code: error.code ?? null,
        message: error.message,
      };
    }
  }
  let replay = null;
  if (item.family === "historical-document" || item.family === "replay-only") {
    replay = item.filename.startsWith("evidence-manifest.")
      ? core.replayEvidenceManifest(item.input)
      : qualification.replayQualificationReceipt(item.input);
  }
  assert.equal(JSON.stringify(item.input), before, `${item.id}: mutated by a validator`);
  results.push({
    id: item.id,
    family: item.family,
    filename: item.filename,
    jsonSchema,
    zod: zod.success,
    parser,
    replay,
    jsonErrors,
    zodErrors: zod.success ? null : zod.error.issues,
  });
}
for (const base of bases) {
  const r = results.find((x) => x.id === base.id);
  assert.equal(r.jsonSchema, true, base.id);
  assert.equal(r.zod, true, base.id);
  if (r.parser) assert.equal(r.parser.accepted, true, base.id);
  if (r.replay) assert.equal(r.replay.valid, true, base.id);
}
const families = {};
for (const r of results) {
  families[r.family] ??= {
    n: 0,
    jsonSchemaAccepted: 0,
    zodAccepted: 0,
    parserTested: 0,
    parserAccepted: 0,
    replayTested: 0,
    replayValid: 0,
    schemaVsZodDifferences: 0,
    schemaVsParserDifferences: 0,
  };
  const s = families[r.family];
  s.n++;
  s.jsonSchemaAccepted += +r.jsonSchema;
  s.zodAccepted += +r.zod;
  s.parserTested += +(r.parser !== null);
  s.parserAccepted += +(r.parser?.accepted === true);
  s.replayTested += +(r.replay !== null);
  s.replayValid += +(r.replay?.valid === true);
  s.schemaVsZodDifferences += +(r.jsonSchema !== r.zod);
  s.schemaVsParserDifferences += +(r.parser !== null && r.jsonSchema !== r.parser.accepted);
}
const metadata = {
  sha: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  zod: load("node_modules/zod/package.json").version,
  ajv: load("node_modules/ajv/package.json").version,
  options,
  compiledSchemas: schemaInventory.length,
  exercisedSchemas: new Set(corpus.map((x) => x.filename)).size,
  cases: corpus.length,
  families,
};
for (const [filename, value] of [
  ["corpus.json", corpus],
  ["results.json", { metadata, results }],
  ["schema-inventory.json", schemaInventory],
]) {
  fs.writeFileSync(path.join(lab, filename), `${JSON.stringify(value, null, 2)}\n`);
}
console.log(JSON.stringify(metadata, null, 2));
console.log("sha256 corpus.json", sha(fs.readFileSync(path.join(lab, "corpus.json"))));
console.log("sha256 results.json", sha(fs.readFileSync(path.join(lab, "results.json"))));
