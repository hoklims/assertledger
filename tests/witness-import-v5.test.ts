import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseEvidenceManifestV5, parseWitnessImportRequestV2 } from "../src/contracts/index.js";
import { replayEvidenceManifest, sealManifestArtifact } from "../src/core/index.js";
import { AssertLedger } from "../src/sdk/index.js";

const bun = process.env.ASSERTLEDGER_BUN_EXECUTABLE ?? "bun";
const temporaryDirectories: string[] = [];
const ENVIRONMENT = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"];
const directoryLinkType = process.platform === "win32" ? "junction" : "dir";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

const BASE = 'export const names = () => ["a", "docs"];\n';
const MUTANT = 'export const names = () => ["a"];\n';
const digest = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
const REGISTER = `import { expect } from "bun:test";
expect.extend({
  toHoldDocs(received: unknown) {
    const pass = Array.isArray(received) && received.includes("docs");
    return { pass, message: () => "expected the docs entry" };
  },
});
`;

/**
 * A pnpm-shaped workspace: the web package's bunfig preloads a package reached through an
 * installed link, then a setup file whose matcher package registers a custom matcher. The compat
 * package's own tsconfig maps its name, which the runtime does not apply to web.
 */
async function workspace(files: Record<string, string> = {}): Promise<string> {
  const root = await temporaryDirectory("assertledger-witness-v5-");
  const contents: Record<string, string> = {
    "package.json": '{"name":"fixture","private":true,"type":"module"}\n',
    "web/package.json": '{"name":"web","type":"module"}\n',
    "web/bunfig.toml": '[test]\npreload = ["@scope/compat/preload", "./src/setup.ts"]\n',
    "web/src/setup.ts": 'import "@scope/matchers/register";\n',
    "web/src/names.ts": BASE,
    "web/src/names.spec.ts": `import { describe, expect, it } from "vitest";
import { names } from "./names";
describe("gate routing", () => {
  it("keeps docs", () => {
    expect((globalThis as { compat?: boolean }).compat).toBe(true);
    expect(names()).toContain("docs");
  });
  it("holds docs", () => {
    (expect(names()) as unknown as { toHoldDocs(): void }).toHoldDocs();
  });
});
`,
    "tools/compat/package.json":
      '{"name":"@scope/compat","type":"module","exports":{"./preload":"./src/preload.ts"}}\n',
    "tools/compat/tsconfig.json": '{"compilerOptions":{"paths":{"@scope/compat/*":["./src/*"]}}}\n',
    "tools/compat/src/preload.ts": "(globalThis as { compat?: boolean }).compat = true;\n",
    "tools/matchers/package.json":
      '{"name":"@scope/matchers","type":"module","exports":{"./register":"./register.ts"}}\n',
    "tools/matchers/register.ts": REGISTER,
    "unrelated/notes.txt": "not on any test closure\n",
    ...files,
  };
  for (const [relative, content] of Object.entries(contents)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  for (const [link, target] of [
    ["web/node_modules/@scope/compat", "tools/compat"],
    ["web/node_modules/@scope/matchers", "tools/matchers"],
  ] as const) {
    await mkdir(path.dirname(path.join(root, link)), { recursive: true });
    await symlink(
      process.platform === "win32"
        ? path.join(root, target)
        : path.relative(path.dirname(path.join(root, link)), path.join(root, target)),
      path.join(root, link),
      directoryLinkType,
    );
  }
  return root;
}

function witness(
  root: string,
  overrides: {
    test?: string;
    expectedFailure?: string;
    trustedMatchers?: { path: string; matchers: string[] }[];
    snapshot?: "repository" | "test-closure";
    include?: string[];
  } = {},
) {
  return {
    schemaVersion: "2.0.0",
    provenance: "fixture witness v2",
    repository: {
      root,
      exclude: [],
      includeDependencies: true,
      git: "excluded",
      snapshot: overrides.snapshot ?? "test-closure",
      include: overrides.include ?? [],
    },
    adapter: {
      kind: "bun-test-designated",
      executable: bun,
      testTimeoutMs: null,
      workingDirectory: "test-package",
      isolate: true,
      trustedMatchers: overrides.trustedMatchers ?? [],
    },
    test: {
      file: "web/src/names.spec.ts",
      path: ["gate routing", overrides.test ?? "keeps docs"],
    },
    expectedFailure: overrides.expectedFailure ?? "error: expect(received).toContain(expected)",
    targets: [{ path: "web/src/names.ts", beforeDigest: digest(BASE), content: MUTANT }],
    neutral: null,
    requiredAttempts: 2,
    timeoutMsPerExecution: 60_000,
  };
}

const local = { kind: "trusted-local" as const, environmentAllowlist: ENVIRONMENT };

async function importInto(request: unknown) {
  const out = path.join(await temporaryDirectory("assertledger-witness-v5-out-"), "evidence");
  const manifest = await new AssertLedger().importWitness(request, { out, isolation: local });
  return { manifest, out };
}

describe("witness import v2", () => {
  it("replays a witness in its package, through installed links, to replay-valid evidence", async () => {
    const root = await workspace();
    const { manifest, out } = await importInto(witness(root));
    assert.equal(manifest.decision.status, "VERIFIED", manifest.decision.reasonCodes.join(","));
    const saved = parseEvidenceManifestV5(
      JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8")),
    );
    assert.equal(saved.schemaVersion, "5.0.0");
    assert.equal(saved.evidenceContext.repository.snapshot, "test-closure");
    assert.equal(saved.evidenceContext.repository.preservedLinkCount, 2);
    assert.equal(replayEvidenceManifest(saved).valid, true);
    // The decision digest binds the snapshot extent: a rewrite resealed with a fresh artifact
    // digest still fails the replay.
    for (const tampered of [
      { snapshot: "repository" },
      { preservedLinkCount: 0 },
      { include: ["unrelated"] },
    ]) {
      const forged = structuredClone(saved);
      Object.assign(forged.evidenceContext.repository, tampered);
      const replay = replayEvidenceManifest(sealManifestArtifact(forged));
      assert.equal(replay.artifactDigestValid, true, JSON.stringify(tampered));
      assert.equal(replay.decisionDigestValid, false, JSON.stringify(tampered));
      assert.equal(replay.valid, false, JSON.stringify(tampered));
    }
    const summary = await readFile(path.join(out, "summary.md"), "utf8");
    assert.match(summary, /Snapshot: test-closure, 2 repository-internal link\(s\) reproduced/u);
  });

  it("binds the snapshot scope: the whole repository and its closure have different digests", async () => {
    const root = await workspace();
    const closure = await importInto(witness(root));
    const whole = await importInto(witness(root, { snapshot: "repository" }));
    assert.equal(whole.manifest.decision.status, "VERIFIED");
    assert.notEqual(closure.manifest.repositoryDigest, whole.manifest.repositoryDigest);
  });

  it("admits a custom matcher's failure only when the operator declares it trusted", async () => {
    const root = await workspace();
    // Bun derives a custom matcher's first message line from its parameters after the received value.
    const custom = { test: "holds docs", expectedFailure: "expect(received).toHoldDocs()" };
    const untrusted = await importInto(witness(root, custom));
    assert.notEqual(untrusted.manifest.decision.status, "VERIFIED");
    assert.equal(
      untrusted.manifest.observations.some((run) => run.outcome === "ASSERTION_FAILURE"),
      false,
    );
    const declared = await importInto(
      witness(root, {
        ...custom,
        trustedMatchers: [{ path: "tools/matchers", matchers: ["toHoldDocs"] }],
      }),
    );
    assert.equal(declared.manifest.decision.status, "VERIFIED");
    // A declaration names a matcher: another name from the same source stays untrusted.
    const otherName = await importInto(
      witness(root, {
        ...custom,
        trustedMatchers: [{ path: "tools/matchers", matchers: ["toHoldOther"] }],
      }),
    );
    assert.notEqual(otherName.manifest.decision.status, "VERIFIED");
  });

  it("never admits a built-in matcher that a repository preload replaced", async () => {
    const root = await workspace({
      "tools/matchers/register.ts": `${REGISTER}expect.extend({
  toContain(received: unknown, expected: unknown) {
    const pass = Array.isArray(received) && received.includes(expected);
    return { pass, message: () => "replaced toContain" };
  },
});
`,
    });
    const replaced = { expectedFailure: "expect(received).toContain(expected)" };
    const { manifest } = await importInto(
      witness(root, {
        ...replaced,
        trustedMatchers: [{ path: "tools/matchers", matchers: ["toHoldDocs"] }],
      }),
    );
    assert.notEqual(manifest.decision.status, "VERIFIED");
    assert.equal(
      manifest.observations.some((run) => run.outcome === "ASSERTION_FAILURE"),
      false,
    );
    // Control: the same failure line is admitted once the operator declares the replacement.
    const declared = await importInto(
      witness(root, {
        ...replaced,
        trustedMatchers: [{ path: "tools/matchers", matchers: ["toHoldDocs", "toContain"] }],
      }),
    );
    assert.equal(declared.manifest.decision.status, "VERIFIED");
  });

  it("refuses a package bunfig whose preloads it cannot rewrite", async () => {
    const root = await workspace({ "web/bunfig.toml": "[test]\npreload = PRELOADS\n" });
    await assert.rejects(importInto(witness(root)), /BUNFIG_TEST_PRELOAD_UNSUPPORTED/u);
  });

  it("validates snapshot includes and trusted matcher sources", async () => {
    const root = await workspace();
    assert.throws(
      () => parseWitnessImportRequestV2(witness(root, { snapshot: "repository", include: ["x"] })),
      /REPOSITORY_INCLUDE_REQUIRES_TEST_CLOSURE/u,
    );
    assert.throws(
      () => parseWitnessImportRequestV2(witness(root, { include: ["unrelated", "unrelated"] })),
      /DUPLICATE_REPOSITORY_INCLUDE/u,
    );
    await assert.rejects(
      importInto(witness(root, { include: ["missing"] })),
      /REPOSITORY_INCLUDE_MISSING/u,
    );
    await assert.rejects(
      importInto(witness(root, { trustedMatchers: [{ path: "../x", matchers: ["toX"] }] })),
      /TRUSTED_MATCHER_PATH_INVALID/u,
    );
    await assert.rejects(
      importInto(witness(root, { trustedMatchers: [{ path: "tools/none", matchers: ["toX"] }] })),
      /TRUSTED_MATCHER_PATH_MISSING/u,
    );
  });
});
