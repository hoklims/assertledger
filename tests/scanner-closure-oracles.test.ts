/** Edge-case oracles for the JavaScript scanner, module specifier discovery and the test closure
 * (ADR 0002, E7). Each case freezes an input and the exact output the TypeScript implementation
 * produces, or its refusal. The cases sit where another implementation most easily diverges:
 * UTF-16 positions, trivia the scanner skips, context-free regex scanning, literal values,
 * resolution order, path keys and UTF-16 path order. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { SyntaxKind } from "typescript/unstable/ast";
import { scanJavaScriptTokens } from "../src/engine/javascript-tokens.js";
import { computeTestClosure, scanModuleSpecifiers } from "../src/engine/test-closure.js";
import { PACKAGE_ROOT } from "./support/goldens.js";

/** [kind, start, end, text] or, for the kinds whose value is read, [kind, start, end, text, value]. */
type TokenTuple = [string, number, number, string] | [string, number, number, string, string];

interface TokenCase {
  id: string;
  description: string;
  source: string;
  tokens: TokenTuple[];
}

interface SpecifierCase {
  id: string;
  description: string;
  source: string;
  specifiers: string[];
  nonLiteral: boolean;
}

interface ClosureCase {
  id: string;
  description: string;
  files: Record<string, string>;
  links?: string[];
  linkTargets?: Record<string, string>;
  roots: string[];
  runnerModules?: string[];
  closure?: { files: string[]; links: string[]; unbounded: { file: string; reason: string }[] };
  refusal?: string;
}

/** Kinds whose value consumers read; any other token's value is unspecified. */
const VALUE_KINDS = new Set([
  "Identifier",
  "PrivateIdentifier",
  "StringLiteral",
  "NoSubstitutionTemplateLiteral",
  "TemplateHead",
  "TemplateMiddle",
  "TemplateTail",
  "NumericLiteral",
  "BigIntLiteral",
]);

/** The divergence traps a later implementation must face; removing one fails the suite. */
const REQUIRED = {
  tokens: [
    "utf16-astral-positions",
    "bom-skipped-shebang-not",
    "numeric-literal-values",
    "string-escape-values",
    "template-nesting",
    "regex-not-recognized",
    "empty-private-identifier-skipped",
    "conflict-markers-skipped",
  ],
  specifiers: [
    "dynamic-computed",
    "dynamic-concatenation",
    "mock-module",
    "escaped-specifiers",
    "semicolon-stops-from",
    "regex-hides-import",
  ],
  closures: [
    "resolution-candidates",
    "path-keys-and-order",
    "unbounded-edges",
    "packages-and-runner-modules",
    "link-followed",
    "package-import-unmatched-refused",
  ],
};

/** The first name of each SyntaxKind value, never a FirstToken or LastToken style alias. */
const KIND_NAMES = new Map<number, string>();
for (const [name, value] of Object.entries(SyntaxKind)) {
  if (typeof value === "number" && !KIND_NAMES.has(value)) KIND_NAMES.set(value, name);
}

async function fixture<T>(name: string): Promise<T[]> {
  const text = await readFile(path.join(PACKAGE_ROOT, "tests", "edge-oracles", name), "utf8");
  return (JSON.parse(text) as { cases: T[] }).cases;
}

const tokenCases = await fixture<TokenCase>("javascript-tokens.json");
const specifierCases = await fixture<SpecifierCase>("module-specifiers.json");
const closureCases = await fixture<ClosureCase>("test-closure.json");

function assertTraps(cases: readonly { id: string }[], required: readonly string[]): void {
  const ids = cases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    required.filter((id) => !ids.includes(id)),
    [],
  );
}

describe("JavaScript scanner edge-case oracles", () => {
  it("keep every divergence trap, each case once", () => {
    assertTraps(tokenCases, REQUIRED.tokens);
  });

  for (const entry of tokenCases) {
    it(`${entry.id}: ${entry.description}`, () => {
      const tokens = [...scanJavaScriptTokens(entry.source)].map((token): TokenTuple => {
        const kind = KIND_NAMES.get(token.kind) ?? String(token.kind);
        return VALUE_KINDS.has(kind)
          ? [kind, token.start, token.end, token.text, token.value]
          : [kind, token.start, token.end, token.text];
      });
      assert.deepEqual(tokens, entry.tokens);
      // Positions are UTF-16 code unit offsets: each text is the source slice they delimit.
      for (const [, start, end, text] of entry.tokens) {
        assert.equal(entry.source.slice(start, end), text);
      }
    });
  }
});

describe("module specifier edge-case oracles", () => {
  it("keep every divergence trap, each case once", () => {
    assertTraps(specifierCases, REQUIRED.specifiers);
  });

  for (const entry of specifierCases) {
    it(`${entry.id}: ${entry.description}`, () => {
      const scan = scanModuleSpecifiers(entry.source);
      assert.deepEqual([...scan.specifiers].sort(), entry.specifiers);
      assert.equal(scan.nonLiteral, entry.nonLiteral);
    });
  }
});

describe("test closure edge-case oracles", () => {
  it("keep every divergence trap, each case once", () => {
    assertTraps(closureCases, REQUIRED.closures);
  });

  for (const entry of closureCases) {
    it(`${entry.id}: ${entry.description}`, async () => {
      const closure = computeTestClosure({
        files: Object.keys(entry.files),
        links: entry.links ?? [],
        roots: entry.roots,
        read: async (file) => (file in entry.files ? [entry.files[file] as string] : []),
        ...(entry.linkTargets === undefined
          ? {}
          : { linkTargets: new Map(Object.entries(entry.linkTargets)) }),
        ...(entry.runnerModules === undefined
          ? {}
          : { runnerModules: new Set(entry.runnerModules) }),
      });
      if (entry.refusal !== undefined) {
        assert.equal(entry.closure, undefined);
        await assert.rejects(closure, { message: entry.refusal });
        return;
      }
      assert.deepEqual(await closure, entry.closure);
    });
  }
});
