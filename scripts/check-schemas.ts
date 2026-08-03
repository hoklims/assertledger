import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  evidenceManifestJsonSchema,
  replayResultJsonSchema,
  repositoryAnalysisJsonSchema,
  verificationRequestJsonSchema,
} from "../src/contracts/index.js";

const schemaDirectory = path.resolve("schemas");
const expectedSchemas = [
  ["verification-request.v1.json", verificationRequestJsonSchema()],
  ["repository-analysis.v1.json", repositoryAnalysisJsonSchema()],
  ["evidence-manifest.v1.json", evidenceManifestJsonSchema()],
  ["replay-result.v1.json", replayResultJsonSchema()],
] as const;

const staleSchemas: string[] = [];
for (const [filename, expected] of expectedSchemas) {
  try {
    const actual = JSON.parse(
      await readFile(path.join(schemaDirectory, filename), "utf8"),
    ) as unknown;
    if (!isDeepStrictEqual(actual, expected)) staleSchemas.push(filename);
  } catch {
    staleSchemas.push(filename);
  }
}

if (staleSchemas.length > 0) {
  throw new Error(`STALE_JSON_SCHEMAS: ${staleSchemas.join(", ")}`);
}
