import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** A gate test whose second test always passes; `body` is the designated test's callback. */
export const TEST_SOURCE = (body: string) =>
  `import { describe, expect, test } from "bun:test";\nimport { names } from "../src/names";\ndescribe("gate routing", () => {\n  test("keeps docs", ${body});\n  test("other", () => { expect(1).toBe(1); });\n});\n`;
export const KEEPS_DOCS = '() => { expect(names()).toContain("docs"); }';
/** Under the fault the test busy-waits past a short per-test timeout, then fails its matcher. */
export const OVERRUNS_UNDER_FAULT =
  '() => { const stop = Date.now() + (names().length === 1 ? 600 : 0); while (Date.now() < stop); expect(names()).toContain("docs"); }';
export const FAULT = 'export const names = () => ["a"];\n';

export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
}

/** A Bun repository in `root` with an unrelated skills link and a gate test named by its path. */
export async function designatedRepository(
  root: string,
  testBody = KEEPS_DOCS,
  extra: Record<string, string> = {},
): Promise<string> {
  await writeTree(root, {
    "package.json": '{"type":"module"}\n',
    "tools/a.test.ts": TEST_SOURCE(testBody),
    "src/names.ts": 'export const names = () => ["a", "docs"];\n',
    ".agents/skills/SKILL.md": "# skill\n",
    ...extra,
  });
  await mkdir(path.join(root, ".claude"));
  await symlink(
    path.join(root, ".agents", "skills"),
    path.join(root, ".claude", "skills"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return root;
}

export interface DesignatedCampaignOptions {
  isolation?: Record<string, unknown>;
  git?: "excluded" | "synthesized";
  testTimeoutMs?: number | null;
  expectedFailure?: string | null;
}

/** A v4 campaign of the gate test: the repository as reference, `targetSource` as the fault. */
export function designatedCampaign(
  root: string,
  executable: string,
  targetSource: string,
  options: DesignatedCampaignOptions = {},
) {
  return {
    schemaVersion: "4.0.0",
    repository: { root, exclude: [], includeDependencies: false, git: options.git ?? "excluded" },
    adapter: {
      kind: "bun-test-designated",
      executable,
      testTimeoutMs: options.testTimeoutMs ?? null,
    },
    isolation: options.isolation ?? {
      kind: "trusted-local",
      acknowledgedUnsafeExecution: true,
      environmentAllowlist: ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"],
    },
    candidateRoots: ["tools/a.test.ts"],
    budgets: {
      maximumCandidates: 1,
      maximumWorlds: 3,
      maximumExecutions: 12,
      maximumRepositoryFiles: 1_000,
      maximumRepositoryBytes: 10_000_000,
      maximumWorldOverlayBytes: 100_000,
      maximumCandidateBytes: 1,
      maximumTotalCandidateBytes: 1,
      timeoutMsPerExecution: 60_000,
      maximumOutputBytes: 65_536,
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: 2,
      minimumTargetWeightPermille: 1_000,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds: [
      {
        id: "reference",
        kind: "REFERENCE",
        required: true,
        weight: 0,
        provenance: "fixture:correct",
        files: [],
      },
      {
        id: "target",
        kind: "TARGET",
        required: true,
        weight: 1,
        provenance: "fixture:fault",
        files: [{ path: "src/names.ts", content: targetSource }],
      },
      {
        id: "neutral",
        kind: "NEUTRAL",
        required: true,
        weight: 0,
        provenance: "fixture:identity",
        files: [],
      },
    ],
    candidates: [
      {
        id: "designated",
        test: { file: "tools/a.test.ts", path: ["gate routing", "keeps docs"] },
        expectedFailure:
          options.expectedFailure === undefined
            ? "error: expect(received).toContain(expected)"
            : options.expectedFailure,
      },
    ],
  };
}
