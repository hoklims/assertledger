import assert from "node:assert/strict";
import { test } from "node:test";
import { publishedSchemas } from "../scripts/schema-registry.js";

test("qualification registry publishes all four generated contracts", () => {
  const schemas = new Map(publishedSchemas());
  for (const name of [
    "qualification-plan",
    "qualification-execution-request",
    "qualification-receipt",
    "qualification-replay-result",
  ]) {
    const filename = `${name}.v1.json`;
    const schema = schemas.get(filename);
    assert.ok(schema, `missing published schema: ${filename}`);
    assert.equal(schema.$id, `https://testforge.dev/schemas/${filename}`);
  }
});
