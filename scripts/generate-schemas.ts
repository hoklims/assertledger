import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  evidenceManifestJsonSchema,
  replayResultJsonSchema,
  repositoryAnalysisJsonSchema,
  verificationRequestJsonSchema,
} from "../src/contracts/index.js";

const outputDirectory = path.resolve("schemas");
await mkdir(outputDirectory, { recursive: true });
const schemas = [
  ["verification-request.v1.json", verificationRequestJsonSchema()],
  ["repository-analysis.v1.json", repositoryAnalysisJsonSchema()],
  ["evidence-manifest.v1.json", evidenceManifestJsonSchema()],
  ["replay-result.v1.json", replayResultJsonSchema()],
] as const;

for (const [filename, schema] of schemas) {
  await writeFile(
    path.join(outputDirectory, filename),
    `${JSON.stringify(schema, null, 2)}\n`,
    "utf8",
  );
}
