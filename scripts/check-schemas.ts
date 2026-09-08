import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { publishedSchemas } from "./schema-registry.js";

const schemaDirectory = path.resolve("schemas");
const expectedSchemas = publishedSchemas();

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
