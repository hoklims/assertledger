import { createHash } from "node:crypto";
import path from "node:path";
import {
  isCallExpression,
  isIdentifier,
  isStringLiteral,
  type Node,
  visitEachChild,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { sha256Bytes } from "./campaign.js";

export const EXISTING_TESTS_CAMPAIGN_ID =
  "assertledger-self-hosted-core-existing-tests-v1" as const;
export const EXISTING_TESTS_CANDIDATE_ROOT =
  "benchmarks/self-hosted-core/generated-existing-test-candidates" as const;
export const EXISTING_TESTS_SOURCE_PATH = "tests/core.test.ts" as const;
export const EXISTING_TESTS_SNAPSHOT_COUNT = 36 as const;

export interface ExistingTestCase {
  id: string;
  ordinal: number;
  title: string;
  pattern: string;
}

export interface ExistingTestSelection {
  schemaVersion: "1.0.0";
  mode: "existing-core-test";
  candidateId: string;
  title: string;
  pattern: string;
  sourcePath: string;
  sourceDigest: string;
}

export interface ExistingTestCandidate {
  id: string;
  files: readonly { name: string; content: string }[];
}

function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (typeof item !== "object" || item === null) return item;
    return Object.fromEntries(
      Object.entries(item)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sort(entry)]),
    );
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function exactPattern(title: string): string {
  return `^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

function stableId(title: string): string {
  return `core-it-${createHash("sha256").update(title).digest("hex").slice(0, 16)}`;
}

export function extractExistingCoreTests(sourcePath: string): readonly ExistingTestCase[] {
  const absolutePath = path.resolve(sourcePath);
  const api = new API({ cwd: path.dirname(absolutePath) });
  const titles: string[] = [];
  try {
    const snapshot = api.updateSnapshot({ openFiles: [absolutePath] });
    const project = snapshot.getDefaultProjectForFile(absolutePath);
    const sourceFile = project?.program.getSourceFile(absolutePath);
    if (!project || !sourceFile) throw new Error("CORE_TEST_SOURCE_NOT_IN_TYPESCRIPT_PROJECT");
    if (project.program.getSyntacticDiagnostics(absolutePath).length > 0) {
      throw new Error("CORE_TEST_SOURCE_SYNTAX_INVALID");
    }
    const visit = (node: Node): void => {
      if (
        isCallExpression(node) &&
        isIdentifier(node.expression) &&
        node.expression.text === "it"
      ) {
        const title = node.arguments[0];
        if (!title || !isStringLiteral(title)) throw new Error("CORE_TEST_TITLE_NOT_LITERAL");
        titles.push(title.text);
      }
      visitEachChild(node, (child) => {
        visit(child);
        return child;
      });
    };
    visit(sourceFile);
  } finally {
    api.close();
  }

  const seenTitles = new Set<string>();
  const seenIds = new Set<string>();
  return titles.map((title, index) => {
    if (seenTitles.has(title)) throw new Error(`CORE_TEST_TITLE_COLLISION:${title}`);
    seenTitles.add(title);
    const id = stableId(title);
    if (seenIds.has(id)) throw new Error(`CORE_TEST_ID_COLLISION:${id}`);
    seenIds.add(id);
    return { id, ordinal: index + 1, title, pattern: exactPattern(title) };
  });
}

export function adaptExistingCoreTestSource(source: string): string {
  const original = 'import("../src/core/index.js")';
  const adapted = 'import("../../../../src/core/index.js")';
  const first = source.indexOf(original);
  if (first < 0 || source.indexOf(original, first + original.length) >= 0) {
    throw new Error("CORE_TEST_IMPORT_NOT_UNIQUE");
  }
  return `${source.slice(0, first)}${adapted}${source.slice(first + original.length)}`;
}

export function buildExistingTestCandidates(
  source: string,
  catalogue: readonly ExistingTestCase[],
): {
  catalogue: readonly ExistingTestCase[];
  candidates: readonly ExistingTestCandidate[];
  adaptedSource: string;
} {
  const adaptedSource = adaptExistingCoreTestSource(source);
  const sourceDigest = sha256Bytes(adaptedSource);
  const candidates = catalogue.map((testCase) => {
    const selection: ExistingTestSelection = {
      schemaVersion: "1.0.0",
      mode: "existing-core-test",
      candidateId: testCase.id,
      title: testCase.title,
      pattern: testCase.pattern,
      sourcePath: "core.test.ts",
      sourceDigest,
    };
    return {
      id: testCase.id,
      files: [
        { name: "core.test.ts", content: adaptedSource },
        { name: "selection.json", content: stableJson(selection) },
      ],
    };
  });
  return { catalogue, candidates, adaptedSource };
}
