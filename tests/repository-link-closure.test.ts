import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { type CliIo, runCli } from "../src/cli.js";
import type { RepositoryLinkAssessment } from "../src/engine/index.js";
import { computeTestClosure } from "../src/engine/test-closure.js";
import { AssertLedger } from "../src/sdk/index.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
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

/** A Bun repository whose only test imports src/value.ts, with an unrelated skills directory. */
async function bunRepository(files: Record<string, string> = {}): Promise<string> {
  const root = await temporaryDirectory("assertledger-link-closure-");
  const contents: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: "fixture", packageManager: "bun@1.4.2", scripts: { test: "bun test" } })}\n`,
    "bun.lock": "{}\n",
    "tests/value.test.ts":
      'import { expect, test } from "bun:test";\nimport { value } from "../src/value";\ntest("value", () => expect(value).toBe(1));\n',
    "src/value.ts": "export const value = 1;\n",
    ".agents/skills/SKILL.md": "# skill\n",
    ...files,
  };
  for (const [relative, content] of Object.entries(contents)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  return root;
}

async function linkDirectory(root: string, target: string, link: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, link)), { recursive: true });
  await symlink(path.resolve(root, target), path.join(root, link), directoryLinkType);
}

function capture(root: string) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    cwd: root,
    readStdin: async () => "",
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  };
  return { io, stdout: () => stdout, stderr: () => stderr };
}

async function doctor(root: string, framework?: string) {
  const assessments: RepositoryLinkAssessment[] = [];
  const result = await new AssertLedger().doctor(root, {
    ...(framework === undefined ? {} : { framework }),
    onLinkAssessment: (assessment) => assessments.push(assessment),
  });
  return { result, assessment: assessments.at(-1) };
}

describe("repository links judged against the executed test closure", () => {
  it("plans a repository whose only link is outside every test closure, and names it", async () => {
    const root = await bunRepository();
    await linkDirectory(root, ".agents/skills", ".claude/skills");

    const { result, assessment } = await doctor(root);
    assert.equal(result.status, "WOULD_CREATE");
    assert.deepEqual(result.reasonCodes, ["REPOSITORY_LINK_OUTSIDE_TEST_CLOSURE"]);
    assert.deepEqual(assessment?.omitted, [".claude/skills"]);
    assert.equal(assessment?.refused, undefined);

    const cli = capture(root);
    assert.equal(await runCli(["doctor", "."], cli.io), 0);
    assert.match(cli.stderr(), /Links outside every test closure: 1/u);

    // The repository analysis still refuses any link: only the closure-aware paths changed.
    await assert.rejects(new AssertLedger().analyze(root), /UNSUPPORTED_REPOSITORY_SYMLINK/u);
  });

  it("refuses a link on the module closure of a test and names its path", async () => {
    const root = await bunRepository({
      "tests/value.test.ts":
        'import { expect, test } from "bun:test";\nimport { value } from "../src/linked/value";\ntest("value", () => expect(value).toBe(1));\n',
      "src/real/value.ts": "export const value = 1;\n",
    });
    await linkDirectory(root, "src/real", "src/linked");
    await linkDirectory(root, ".agents/skills", ".claude/skills");

    const { result, assessment } = await doctor(root);
    assert.equal(result.status, "CONFLICT");
    assert.deepEqual(result.reasonCodes, [
      "REPOSITORY_LINK_IN_TEST_CLOSURE",
      "UNSUPPORTED_REPOSITORY_SYMLINK",
    ]);
    assert.deepEqual(assessment?.refused, {
      path: "src/linked",
      reasonCode: "REPOSITORY_LINK_IN_TEST_CLOSURE",
    });

    const cli = capture(root);
    assert.equal(await runCli(["doctor", "."], cli.io), 4);
    assert.match(cli.stderr(), /Link detail: "src\/linked" \(REPOSITORY_LINK_IN_TEST_CLOSURE\)/u);
    assert.doesNotMatch(cli.stdout(), /no explanation in the installed catalogue/u);
  });

  it("refuses a linked directory through which a runner discovers a test", async () => {
    const root = await bunRepository({
      "fixtures/suite/extra.test.ts":
        'import { test } from "bun:test";\ntest("extra", () => {});\n',
    });
    await linkDirectory(root, "fixtures/suite", "vendor/suite");

    const { result, assessment } = await doctor(root);
    assert.equal(result.status, "CONFLICT");
    assert.deepEqual(assessment?.refused, {
      path: "vendor/suite",
      reasonCode: "REPOSITORY_LINK_IN_TEST_CLOSURE",
    });
  });

  it("refuses a link that leaves the repository whatever the closure", async () => {
    const root = await bunRepository();
    const outside = await temporaryDirectory("assertledger-link-outside-");
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await symlink(outside, path.join(root, ".claude", "skills"), directoryLinkType);

    const { result, assessment } = await doctor(root);
    assert.equal(result.status, "CONFLICT");
    assert.deepEqual(result.reasonCodes, [
      "REPOSITORY_LINK_ESCAPES_ROOT",
      "UNSUPPORTED_REPOSITORY_SYMLINK",
    ]);
    assert.deepEqual(assessment?.refused, {
      path: ".claude/skills",
      reasonCode: "REPOSITORY_LINK_ESCAPES_ROOT",
    });
  });

  it("reports a computed import as an unbounded closure without refusing the static plan", async () => {
    const root = await bunRepository({
      "tests/dynamic.test.ts":
        'import { test } from "bun:test";\nconst name = "../src/value";\ntest("dynamic", async () => { await import(name); });\n',
    });
    await linkDirectory(root, ".agents/skills", ".claude/skills");

    const { result, assessment } = await doctor(root);
    assert.equal(result.status, "WOULD_CREATE");
    assert.deepEqual(result.reasonCodes, [
      "REPOSITORY_LINK_OUTSIDE_TEST_CLOSURE",
      "TEST_CLOSURE_UNBOUNDED",
    ]);
    assert.deepEqual(assessment?.unbounded, [
      { file: "tests/dynamic.test.ts", reason: "NON_LITERAL_MODULE_SPECIFIER" },
    ]);
  });
});

describe("static test module closure", () => {
  const read = (sources: Record<string, string>) => async (file: string) =>
    sources[file] === undefined ? [] : [sources[file] as string];

  it("follows literal imports, tsconfig paths, preloads and workspace packages", async () => {
    const sources: Record<string, string> = {
      "package.json": '{"workspaces":["packages/*"]}',
      "tsconfig.json": '{ // comment\n "compilerOptions": { "paths": { "@app/*": ["src/*"] } } }',
      "bunfig.toml": '[test]\npreload = ["./tests/setup.ts"]\n',
      "tests/setup.ts": "export {};\n",
      "tests/a.test.ts":
        'import "@app/one";\nimport { two } from "../src/two.js";\nexport * from "@scope/core";\nconst lazy = () => import("./helper");\n',
      "tests/helper.ts": "export const helper = 1;\n",
      "src/one.ts": 'import "./nested/index";\n',
      "src/nested/index.ts": "export {};\n",
      "src/two.ts": "export const two = 2;\n",
      "src/unrelated.ts": "export {};\n",
      "packages/core/package.json": '{"name":"@scope/core"}',
      "packages/core/index.ts": "export const core = 1;\n",
    };
    const closure = await computeTestClosure({
      files: Object.keys(sources),
      links: [],
      roots: ["tests/a.test.ts"],
      read: read(sources),
    });
    for (const expected of [
      "bunfig.toml",
      "package.json",
      "packages/core/index.ts",
      "packages/core/package.json",
      "src/nested/index.ts",
      "src/one.ts",
      "src/two.ts",
      "tests/a.test.ts",
      "tests/helper.ts",
      "tests/setup.ts",
      "tsconfig.json",
    ]) {
      assert.ok(closure.files.includes(expected), expected);
    }
    assert.equal(closure.files.includes("src/unrelated.ts"), false);
    assert.deepEqual(closure.links, []);
    assert.deepEqual(closure.unbounded, []);
  });

  it("puts a workspace package's installed link on the resolution path", async () => {
    const sources: Record<string, string> = {
      "package.json": '{"workspaces":["packages/*"]}',
      "tests/a.test.ts": 'import "@scope/core";\n',
      "packages/core/package.json": '{"name":"@scope/core"}',
      "packages/core/index.ts": "export {};\n",
    };
    const closure = await computeTestClosure({
      files: Object.keys(sources),
      links: ["node_modules/@scope/core"],
      roots: ["tests/a.test.ts"],
      read: read(sources),
    });
    assert.deepEqual(closure.links, ["node_modules/@scope/core"]);
  });

  it("marks computed, absolute and escaping specifiers as unbounded edges", async () => {
    const sources: Record<string, string> = {
      "tests/a.test.ts":
        'const name = "x";\nrequire(name);\nimport "/abs/module";\nimport "../../outside";\n',
    };
    const closure = await computeTestClosure({
      files: Object.keys(sources),
      links: [],
      roots: ["tests/a.test.ts"],
      read: read(sources),
    });
    assert.deepEqual(closure.unbounded.map((edge) => edge.reason).sort(), [
      "ABSOLUTE_MODULE_SPECIFIER",
      "MODULE_OUTSIDE_REPOSITORY",
      "NON_LITERAL_MODULE_SPECIFIER",
    ]);
  });
});

// The real case: a git archive of dofus_battlebot at 484e85ae (never its shared checkout) plus the
// untracked .claude/skills junction its checkout carries. Set ASSERTLEDGER_DOFUS_REPOSITORY to the
// repository to read the archive from; the repository itself is only read.
const dofusRepository = process.env.ASSERTLEDGER_DOFUS_REPOSITORY ?? "";
const DOFUS_REVISION = "484e85aebc662c4b77acfdcb440384fb66b1a82d";

describe("doctor on a git archive of dofus_battlebot 484e85ae", {
  skip: dofusRepository === "" ? "set ASSERTLEDGER_DOFUS_REPOSITORY to run" : false,
}, () => {
  async function archive(): Promise<string> {
    const parent = await temporaryDirectory("assertledger-dofus-archive-");
    const tarball = path.join(parent, "archive.tar");
    const root = path.join(parent, "repository");
    await mkdir(root);
    await execFileAsync("git", [
      "-C",
      dofusRepository,
      "archive",
      "--format=tar",
      `--output=${tarball}`,
      DOFUS_REVISION,
    ]);
    // A relative archive path keeps GNU tar from reading a drive letter as a remote host.
    await execFileAsync("tar", ["-xf", path.join("..", "archive.tar")], { cwd: root });
    await rm(tarball);
    await linkDirectory(root, ".agents/skills", ".claude/skills");
    return root;
  }

  it("no longer refuses .claude/skills, and still refuses a link placed in a test closure", async () => {
    const root = await archive();
    const outside = await doctor(root, "bun:test");
    assert.notEqual(outside.result.status, "CONFLICT", outside.result.reasonCodes.join(","));
    assert.ok(outside.result.reasonCodes.includes("REPOSITORY_LINK_OUTSIDE_TEST_CLOSURE"));
    assert.deepEqual(outside.assessment?.omitted, [".claude/skills"]);

    await rename(path.join(root, "tools", "proof"), path.join(root, "tools", "proof-real"));
    await linkDirectory(root, "tools/proof-real", "tools/proof");
    const inside = await doctor(root, "bun:test");
    assert.equal(inside.result.status, "CONFLICT");
    assert.deepEqual(inside.assessment?.refused, {
      path: "tools/proof",
      reasonCode: "REPOSITORY_LINK_IN_TEST_CLOSURE",
    });
  });
});
