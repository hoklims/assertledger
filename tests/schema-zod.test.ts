import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ZodError, type ZodType } from "zod";
import * as contracts from "../src/contracts/index.js";
import * as qualification from "../src/contracts/qualification.js";
import { replayEvidenceManifest } from "../src/core/index.js";
import { replayQualificationReceipt } from "../src/core/qualification.js";

interface CorpusCase {
  id: string;
  family: string;
  filename: string;
  input: unknown;
}

interface Observation {
  id: string;
  family: string;
  filename: string;
  jsonSchema: boolean;
  zod: boolean;
  parser: { accepted: boolean; type?: string; code?: string | null; message?: string } | null;
  replay: Record<string, unknown> | null;
}

const boundaries: Record<string, { schema: ZodType; parse: ((value: unknown) => unknown) | null }> =
  {
    "agentic-corpus-allocation-request.v1.json": {
      schema: contracts.AgenticCorpusAllocationRequestSchema,
      parse: contracts.parseAgenticCorpusAllocationRequest,
    },
    "agentic-corpus-trust-policy.v1.json": {
      schema: contracts.AgenticCorpusTrustPolicySchema,
      parse: contracts.parseAgenticCorpusTrustPolicy,
    },
    "evidence-manifest.v1.json": {
      schema: contracts.EvidenceManifestSchema,
      parse: contracts.parseEvidenceManifest,
    },
    "evidence-manifest.v2.json": {
      schema: contracts.EvidenceManifestV2Schema,
      parse: contracts.parseEvidenceManifestV2,
    },
    "evidence-manifest.v3.json": {
      schema: contracts.EvidenceManifestV3Schema,
      parse: contracts.parseEvidenceManifestV3,
    },
    "evidence-manifest.v4.json": {
      schema: contracts.EvidenceManifestV4Schema,
      parse: contracts.parseEvidenceManifestV4,
    },
    "evidence-manifest.v5.json": {
      schema: contracts.EvidenceManifestV5Schema,
      parse: contracts.parseEvidenceManifestV5,
    },
    "qualification-execution-request.v1.json": {
      schema: qualification.QualificationExecutionRequestSchema,
      parse: null,
    },
    "qualification-plan.v1.json": {
      schema: qualification.QualificationPlanSchema,
      parse: qualification.parseQualificationPlan,
    },
    "qualification-receipt.v1.json": {
      schema: qualification.QualificationReceiptSchema,
      parse: null,
    },
    "replay-result.v1.json": {
      schema: contracts.ReplayResultSchema,
      parse: contracts.parseReplayResult,
    },
    "verification-request.v1.json": {
      schema: contracts.VerificationRequestSchema,
      parse: contracts.parseVerificationRequest,
    },
    "verification-request.v2.json": {
      schema: contracts.VerificationRequestV2Schema,
      parse: contracts.parseVerificationRequestV2,
    },
    "verification-request.v3.json": {
      schema: contracts.VerificationRequestV3Schema,
      parse: contracts.parseVerificationRequestV3,
    },
    "verification-request.v4.json": {
      schema: contracts.VerificationRequestV4Schema,
      parse: contracts.parseVerificationRequestV4,
    },
    "verification-request.v5.json": {
      schema: contracts.VerificationRequestV5Schema,
      parse: contracts.parseVerificationRequestV5,
    },
  };

const fixtureRoot = new URL("./schema-zod-corpus/", import.meta.url);
const corpus: CorpusCase[] = JSON.parse(
  gunzipSync(await readFile(new URL("corpus.json.gz", fixtureRoot))).toString("utf8"),
);
const observations: Observation[] = JSON.parse(
  gunzipSync(await readFile(new URL("results.json.gz", fixtureRoot))).toString("utf8"),
).results;
const expectedById = new Map(observations.map((item) => [item.id, item]));
const schemaRoot = new URL("../schemas/", import.meta.url);
const validators = new Map();
for (const filename of (await readdir(schemaRoot)).filter((name) => name.endsWith(".json"))) {
  const schema = JSON.parse(await readFile(new URL(filename, schemaRoot), "utf8"));
  const ajv = new Ajv2020({
    strict: true,
    allowUnionTypes: true,
    allErrors: true,
    unicodeRegExp: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    validateFormats: true,
  });
  validators.set(filename, ajv.compile(schema));
}

assert.equal(corpus.length, 211);
assert.equal(new Set(corpus.map((item) => item.id)).size, corpus.length);
assert.deepEqual(
  observations.map((item) => item.id),
  corpus.map((item) => item.id),
);

describe("JSON Schema/Zod measured non-equivalence", () => {
  for (const item of corpus) {
    it(`${item.family}: ${item.id}`, () => {
      const expected = expectedById.get(item.id);
      const boundary = boundaries[item.filename];
      const validate = validators.get(item.filename);
      assert.ok(expected && boundary && validate, item.id);
      assert.equal(expected.filename, item.filename);
      assert.equal(expected.family, item.family);
      const before = structuredClone(item.input);
      assert.equal(validate(item.input), expected.jsonSchema, "JSON Schema acceptance");
      assert.deepEqual(item.input, before, "JSON Schema must not mutate input");
      assert.equal(boundary.schema.safeParse(item.input).success, expected.zod, "Zod acceptance");
      assert.deepEqual(item.input, before, "Zod must not mutate input");

      const parse = boundary.parse;
      const parser = expected.parser;
      if (parse === null) {
        assert.equal(parser, null, "no standalone parser for this export");
      } else {
        assert.ok(parser);
        if (parser.accepted) {
          parse(item.input);
        } else {
          assert.throws(
            () => parse(item.input),
            (error: unknown) => {
              if (parser.type === "ContractError") {
                return error instanceof contracts.ContractError && error.code === parser.code;
              }
              if (parser.type === "ZodError") return error instanceof ZodError;
              return (
                error instanceof Error &&
                error.constructor === Error &&
                error.message === parser.message
              );
            },
          );
        }
        assert.deepEqual(item.input, before, "parser must not mutate input");
      }

      if (expected.replay !== null) {
        const replay = item.filename.startsWith("evidence-manifest.")
          ? replayEvidenceManifest(item.input)
          : replayQualificationReceipt(item.input);
        assert.deepEqual(replay, expected.replay, "replay integrity and semantic flags");
        assert.deepEqual(item.input, before, "replay must not mutate input");
      }
    });
  }
});
