/** Edge-case oracles for canonical JSON and its digest (ADR 0002). Each case freezes a JSON input text
 * and the exact canonical text and digest the TypeScript implementation produces, or its refusal.
 * The cases sit where another implementation most easily diverges: key order by UTF-16 code unit,
 * ECMAScript number formatting, string escaping and lone surrogates. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { canonicalize, sha256Canonical } from "../src/core/index.js";
import { PACKAGE_ROOT } from "./support/goldens.js";

interface CanonicalCase {
  id: string;
  description: string;
  /** JSON text, parsed as JSON.parse does before canonicalization. */
  input: string;
  canonical?: string;
  digest?: string;
  refused?: true;
}

/** The divergence traps a later implementation must face; removing one fails the suite. */
const REQUIRED_CASES = [
  "key-order-utf16-code-units",
  "number-negative-zero",
  "number-exponent-forms",
  "number-precision-limits",
  "string-control-characters",
  "string-lone-surrogates",
  "duplicate-key-last-wins",
  "number-overflow-refused",
];

const { cases } = JSON.parse(
  await readFile(path.join(PACKAGE_ROOT, "tests", "edge-oracles", "canonical-json.json"), "utf8"),
) as { cases: CanonicalCase[] };

describe("canonical JSON edge-case oracles", () => {
  it("keep every divergence trap, each case once", () => {
    const ids = cases.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(
      REQUIRED_CASES.filter((id) => !ids.includes(id)),
      [],
    );
  });

  for (const entry of cases) {
    it(`${entry.id}: ${entry.description}`, () => {
      const value: unknown = JSON.parse(entry.input);
      if (entry.refused === true) {
        assert.equal(entry.canonical, undefined);
        assert.throws(() => canonicalize(value), TypeError);
        assert.throws(() => sha256Canonical(value), TypeError);
        return;
      }
      assert.equal(canonicalize(value), entry.canonical);
      assert.equal(sha256Canonical(value), entry.digest);
      // The digest is SHA-256 over the UTF-8 bytes of the canonical text, checked independently.
      const bytes = Buffer.from(entry.canonical as string, "utf8");
      assert.equal(entry.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      assert.equal(canonicalize(JSON.parse(entry.canonical as string)), entry.canonical);
    });
  }
});
