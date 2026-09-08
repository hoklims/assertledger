import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { publishedSchemas } from "./schema-registry.js";

const outputDirectory = path.resolve("schemas");
await mkdir(outputDirectory, { recursive: true });
const schemas = publishedSchemas();

for (const [filename, schema] of schemas) {
  await writeFile(
    path.join(outputDirectory, filename),
    `${JSON.stringify(schema, null, 2)}\n`,
    "utf8",
  );
}
