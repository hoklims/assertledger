import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { type CliIo, runCli } from "../src/cli.js";
import { initializeRepository } from "../src/engine/index.js";
import { AssertLedger } from "../src/sdk/index.js";

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function capture(cwd: string) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    cwd,
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

/** Writes `files` under a fresh directory; a key ending in `/` creates an empty directory. */
async function tree(files: Record<string, string>): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), "assertledger-workspace-"));
  temporaryDirectories.push(base);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(base, ...relative.split("/"));
    if (relative.endsWith("/")) {
      await mkdir(target, { recursive: true });
    } else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }
  return base;
}

const BUN_SPEC = 'import { test } from "bun:test";\ntest("one", () => {});\n';
// The member script carries a quoted glob, which init refuses to interpret as one safe command.
const MEMBER_SCRIPT = "bun test --isolate --path-ignore-patterns='**/*.e2e.spec.ts'";
const BUN_COMMAND = JSON.stringify({ executable: "bun", arguments: ["test", "--isolate"] });

function member(packageDocument: Record<string, unknown> = {}): Record<string, string> {
  return {
    "domains/x/api/package.json": JSON.stringify({
      name: "api",
      scripts: { test: MEMBER_SCRIPT },
      ...packageDocument,
    }),
    "domains/x/api/a.spec.ts": BUN_SPEC,
  };
}

async function doctorJson(argv: string[], cwd: string) {
  const output = capture(cwd);
  const code = await runCli(["doctor", ...argv, "--json"], output.io);
  return { code, result: JSON.parse(output.stdout() || "null"), stderr: output.stderr() };
}

describe("doctor accepts the detection overrides of init", () => {
  it("returns the init --dry-run result for the same overrides and writes nothing", async () => {
    const root = await tree({
      "package.json": JSON.stringify({ name: "api", scripts: { test: MEMBER_SCRIPT } }),
      "a.spec.ts": BUN_SPEC,
      "bun-test.json": BUN_COMMAND,
    });
    const overrides = [
      "--framework",
      "bun:test",
      "--package-manager",
      "pnpm",
      "--test-command-json",
      path.join(root, "bun-test.json"),
    ];

    const withoutOverrides = await doctorJson(["--framework", "bun:test"], root);
    assert.equal(withoutOverrides.code, 4);
    assert.deepEqual(withoutOverrides.result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"]);

    const doctor = await doctorJson([root, ...overrides], root);
    const init = capture(root);
    assert.equal(await runCli(["init", root, "--dry-run", ...overrides, "--json"], init.io), 0);

    assert.equal(doctor.stderr, "");
    assert.equal(doctor.code, 0);
    assert.equal(doctor.result.status, "WOULD_CREATE");
    assert.equal(doctor.result.detections.packageManager, "pnpm");
    assert.deepEqual(doctor.result.detections.testCommand, {
      executable: "bun",
      arguments: ["test", "--isolate"],
    });
    assert.deepEqual(doctor.result, JSON.parse(init.stdout()));
    assert.deepEqual((await readdir(root)).sort(), ["a.spec.ts", "bun-test.json", "package.json"]);
  });

  it("forwards --adapter-config and rejects repeated or runtime-mode overrides", async () => {
    const root = await tree({
      "requirements.txt": "pytest==9.0.0\n",
      "test_app.py": "def test_app(): assert True\n",
      "adapter.json": JSON.stringify({
        kind: "testforge-command",
        executable: "python",
        arguments: ["adapter.py"],
        protocolVersion: "1.0.0",
      }),
    });
    const blocked = await doctorJson([root], root);
    assert.equal(blocked.code, 3);
    assert(blocked.result.reasonCodes.includes("OFFICIAL_ADAPTER_UNAVAILABLE"));

    const adapted = await doctorJson([root, "--adapter-config", "adapter.json"], root);
    assert.equal(adapted.code, 0);
    assert.equal(adapted.result.status, "WOULD_CREATE");
    assert.equal(adapted.result.detections.adapterRecommendation, "operator-supplied");

    for (const argv of [
      ["doctor", root, "--package-manager", "pip", "--package-manager", "pip"],
      ["doctor", root, "--test-command-json", "a.json", "--test-command-json", "b.json"],
      ["doctor", root, "--adapter-config", "adapter.json", "--adapter-config", "adapter.json"],
      ["doctor", root, "--runtime", "--package-manager", "pip"],
      ["doctor", root, "--runtime", "--test-command-json", "a.json"],
      ["doctor", root, "--runtime", "--adapter-config", "adapter.json"],
      // A flag without its value is a usage error, never read as a missing option.
      ["doctor", root, "--package-manager"],
      ["doctor", root, "--test-command-json", "--json"],
      ["doctor", root, "--adapter-config"],
      ["doctor", root, "--framework"],
    ]) {
      const output = capture(root);
      assert.equal(await runCli(argv, output.io), 64, argv.join(" "));
    }
  });

  it("accepts the same single-dash path values as init", async () => {
    const root = await tree({
      "requirements.txt": "pytest==9.0.0\n",
      "test_app.py": "def test_app(): assert True\n",
      "-adapter.json": JSON.stringify({
        kind: "testforge-command",
        executable: "python",
        arguments: ["adapter.py"],
        protocolVersion: "1.0.0",
      }),
    });
    const argv = ["--adapter-config", "-adapter.json", "--json"];
    const doctor = await doctorJson([root, ...argv.slice(0, 2)], root);
    const init = capture(root);
    assert.equal(await runCli(["init", root, "--dry-run", ...argv], init.io), 0);
    assert.equal(doctor.code, 0);
    assert.equal(doctor.result.status, "WOULD_CREATE");
    assert.deepEqual(doctor.result, JSON.parse(init.stdout()));
  });

  it("accepts the same --framework value as init, including a single dash", async () => {
    const root = await tree({
      "package.json": JSON.stringify({ name: "api", packageManager: "pnpm@12.11.2" }),
      "pnpm-lock.yaml": "",
      "a.spec.ts": BUN_SPEC,
    });
    const doctor = await doctorJson([root, "--framework", "-invalid"], root);
    const init = capture(root);
    const initCode = await runCli(
      ["init", root, "--dry-run", "--framework", "-invalid", "--json"],
      init.io,
    );
    assert.equal(initCode, 4);
    assert.equal(doctor.code, initCode);
    assert.deepEqual(doctor.result.reasonCodes, ["FRAMEWORK_OVERRIDE_INVALID"]);
    assert.deepEqual(doctor.result, JSON.parse(init.stdout()));
  });

  it("passes the overrides through the SDK facade", async () => {
    const root = await tree({
      "package.json": JSON.stringify({ name: "api", scripts: { test: MEMBER_SCRIPT } }),
      "a.spec.ts": BUN_SPEC,
    });
    const result = await new AssertLedger().doctor(root, {
      framework: "bun:test",
      packageManager: "pnpm",
      testCommand: { executable: "bun", arguments: ["test", "--isolate"] },
    });
    assert.equal(result.status, "WOULD_CREATE");
    assert.equal(result.detections.packageManager, "pnpm");
  });
});

describe("a workspace member inherits the package manager of its workspace root", () => {
  const rootFiles = {
    ".git/": "",
    "pnpm-workspace.yaml": "packages:\n  - 'domains/*/api'\n  - \"!domains/legacy/**\"\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "package.json": JSON.stringify({
      name: "root",
      packageManager: "pnpm@12.11.2",
      scripts: { test: "turbo test test:repository" },
    }),
  };

  it("detects pnpm from pnpm-workspace.yaml and states where the fact came from", async () => {
    const base = await tree({ ...rootFiles, ...member(), "bun-test.json": BUN_COMMAND });
    const memberRoot = path.join(base, "domains", "x", "api");
    const output = await doctorJson(
      [memberRoot, "--test-command-json", path.join(base, "bun-test.json")],
      base,
    );
    assert.equal(output.code, 0, JSON.stringify(output.result));
    assert.equal(output.result.status, "WOULD_CREATE");
    assert.equal(output.result.detections.packageManager, "pnpm");
    assert.equal(output.result.detections.framework, "bun:test");
    assert.deepEqual(output.result.reasonCodes, ["PACKAGE_MANAGER_FROM_WORKSPACE_ROOT"]);
  });

  it("creates a stable lock from a member and leaves it UNCHANGED on rerun", async () => {
    const base = await tree({ ...rootFiles, ...member() });
    const memberRoot = path.join(base, "domains", "x", "api");
    const options = { testCommand: { executable: "bun", arguments: ["test", "--isolate"] } };
    const created = await initializeRepository(memberRoot, options);
    assert.equal(created.status, "CREATED");
    assert.equal(created.detections.packageManager, "pnpm");
    const unchanged = await initializeRepository(memberRoot, options);
    assert.equal(unchanged.status, "UNCHANGED");
    assert.deepEqual(unchanged.detections, created.detections);
  });

  it("reads only pnpm-workspace.yaml: package.json workspaces declare nothing", async () => {
    // The npm, Yarn and Bun declarations are out of scope: a manager is inherited from pnpm only.
    const cases = [
      {
        "package.json": JSON.stringify({
          name: "root",
          packageManager: "bun@1.4.2",
          workspaces: ["packages/*"],
        }),
      },
      {
        "package.json": JSON.stringify({ name: "root", workspaces: { packages: ["packages/*"] } }),
        "yarn.lock": "",
      },
      {
        "package.json": JSON.stringify({ name: "root", workspaces: ["packages/**"] }),
        "package-lock.json": "{}\n",
      },
      {
        "package.json": JSON.stringify({
          name: "root",
          packageManager: "pnpm@12.11.2",
          workspaces: ["packages/*"],
        }),
        "pnpm-lock.yaml": "",
      },
    ];
    for (const files of cases) {
      const base = await tree({
        ".git/": "",
        ...files,
        "packages/app/package.json": JSON.stringify({ name: "app" }),
        "packages/app/a.test.ts": BUN_SPEC,
      });
      const result = await initializeRepository(path.join(base, "packages", "app"), {
        dryRun: true,
        framework: "bun:test",
      });
      assert.equal(result.status, "CONFLICT", JSON.stringify(files));
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"], JSON.stringify(files));
    }
  });

  it("keeps the member's own manager and any explicit override over the root", async () => {
    const own = await tree({
      ...rootFiles,
      ...member(),
      "domains/x/api/package-lock.json": "{}\n",
    });
    const memberRoot = path.join(own, "domains", "x", "api");
    const detected = await initializeRepository(memberRoot, {
      dryRun: true,
      testCommand: { executable: "bun", arguments: ["test"] },
    });
    assert.equal(detected.detections.packageManager, "npm");
    assert.deepEqual(detected.reasonCodes, []);

    const bare = await tree({ ...rootFiles, ...member() });
    const overridden = await initializeRepository(path.join(bare, "domains", "x", "api"), {
      dryRun: true,
      packageManager: "yarn",
      testCommand: { executable: "bun", arguments: ["test"] },
    });
    assert.equal(overridden.detections.packageManager, "yarn");
    assert.deepEqual(overridden.reasonCodes, []);
  });

  it("does not infer a manager from a root that does not declare the package", async () => {
    const command = { executable: "bun", arguments: ["test"] };
    const undetected = async (files: Record<string, string>, memberPath: string[]) => {
      const base = await tree(files);
      const result = await initializeRepository(path.join(base, ...memberPath), {
        dryRun: true,
        framework: "bun:test",
        testCommand: command,
      });
      assert.equal(result.status, "CONFLICT");
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"]);
    };

    // Not matched by any workspace pattern.
    await undetected(
      { ...rootFiles, "tools/x/package.json": "{}", "tools/x/a.spec.ts": BUN_SPEC },
      ["tools", "x"],
    );
    // Excluded by a negated pattern.
    await undetected(
      {
        ...rootFiles,
        "domains/legacy/api/package.json": "{}",
        "domains/legacy/api/a.spec.ts": BUN_SPEC,
      },
      ["domains", "legacy", "api"],
    );
    // A .git between the member and the workspace root ends the search.
    await undetected({ ...rootFiles, ...member(), "domains/.git/": "" }, ["domains", "x", "api"]);
    // The member is itself the top of its repository.
    await undetected({ ...rootFiles, ...member(), "domains/x/api/.git/": "" }, [
      "domains",
      "x",
      "api",
    ]);
    // Without any .git the search has no boundary and does not run.
    const { ".git/": _git, ...withoutGit } = rootFiles;
    await undetected({ ...withoutGit, ...member() }, ["domains", "x", "api"]);
  });

  it("requires the directory to be a package before inheriting from its workspace", async () => {
    const base = await tree({
      ...rootFiles,
      "domains/x/api/a.spec.ts": BUN_SPEC,
    });
    const result = await initializeRepository(path.join(base, "domains", "x", "api"), {
      dryRun: true,
      framework: "bun:test",
      testCommand: { executable: "bun", arguments: ["test"] },
    });
    assert.equal(result.status, "CONFLICT");
    assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"]);
  });

  it("follows the glob dialect of the workspace managers and refuses what it cannot read", async () => {
    const selecting = [
      ["pnpm-workspace.yaml", "packages:\n  - '{domains,tools}/*/api'\n"],
      ["pnpm-workspace.yaml", "packages: ['domains/[a-z]/api']\n"],
      ["pnpm-workspace.yaml", "packages:\n  - 'domains/{x,y}/{api,web}'\n"],
      ["pnpm-workspace.yaml", "packages:\n  - '**/api'\n"],
      ["pnpm-workspace.yaml", "packages:\n  - 'domains/x/ap?'\n"],
      ["pnpm-workspace.yaml", "packages:\n  - 'domains/**'\n"],
      // A class holds its comma: it is not an alternative separator.
      ["pnpm-workspace.yaml", "packages:\n  - 'domains/{[x-y],z}/api'\n"],
      ["pnpm-workspace.yaml", "packages:\n  - 'domains/{[a,x],q}/api'\n"],
      ["pnpm-workspace.yaml", "packages:\n  - 'domains/*/*'\n  - '!domains/*/web'\n"],
    ] as const;
    for (const [file, content] of selecting) {
      const base = await tree({
        ".git/": "",
        [file]: content,
        "pnpm-lock.yaml": "",
        ...member(),
      });
      const result = await initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
      assert.equal(result.detections.packageManager, "pnpm", content);
      assert.equal(result.status, "WOULD_CREATE", content);
    }

    const refused = [
      // Understood, and not selecting the member.
      "packages:\n  - 'domains/[^x]/api'\n",
      "packages:\n  - 'domains/y/api'\n",
      // A nested sequence item is an object entry for the manager: not a pattern.
      "packages:\n  - 'domains/*/api'\n  - - 'other/*'\n",
      "packages:\n  - 'domains/*/api'\n  - ? x\n",
      // `..` is normalized: this is `domains/y/api`.
      "packages:\n  - 'domains/x/../y/api'\n",
      "packages:\n  - 'domains/x/ap'\n",
      "packages:\n  - 'domains/*'\n",
      "packages:\n  - 'domains/*/*'\n  - '!domains/x/*'\n",
      // Not understood: a class that opens with `!` or `^` is a negation in some glob dialects
      // and a literal in others, so it selects nothing here whichever the manager means.
      "packages:\n  - 'domains/[!a-c]/api'\n",
      "packages:\n  - 'domains/[!b]/api'\n",
      "packages:\n  - 'domains/[^b]/api'\n",
      "packages:\n  - 'domains/+(x|y)/api'\n",
      "packages:\n  - 'domains/{1..3}/api'\n",
      "packages:\n  - 'domains/[[:alpha:]]/api'\n",
      "packages:\n  - 'domains/{x}/api'\n",
      "packages:\n  - 'domains/x/api'\n  - 'domains/@(a|b)'\n",
    ];
    for (const content of refused) {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        ...member(),
      });
      const result = await initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
      assert.equal(result.status, "CONFLICT", content);
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"], content);
    }
  });

  it("fails closed on a workspace root whose manifest cannot be read", async () => {
    const invalid = await tree({
      ...rootFiles,
      "package.json": "{ not json",
      ...member(),
    });
    const refused = await initializeRepository(path.join(invalid, "domains", "x", "api"), {
      dryRun: true,
      testCommand: { executable: "bun", arguments: ["test"] },
    });
    assert.equal(refused.status, "CONFLICT");
    assert.deepEqual(refused.reasonCodes, ["PACKAGE_MANIFEST_INVALID"]);

    // A workspace root that has no manifest at all is still a pnpm workspace.
    const { "package.json": _manifest, ...withoutManifest } = rootFiles;
    const absent = await tree({ ...withoutManifest, ...member() });
    const accepted = await initializeRepository(path.join(absent, "domains", "x", "api"), {
      dryRun: true,
      testCommand: { executable: "bun", arguments: ["test"] },
    });
    assert.equal(accepted.status, "WOULD_CREATE");
    assert.equal(accepted.detections.packageManager, "pnpm");
  });

  it("reads the package list only as a flat sequence under packages", async () => {
    const run = async (content: string) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        ...member(),
      });
      return initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    const flat = await run("packages:\n  - 'domains/*/api'\n  - 'tools/*'\n");
    assert.equal(flat.status, "WOULD_CREATE");
    // A sequence at the indentation of the key is still the list.
    const aligned = await run("packages:\n- 'domains/*/api'\n");
    assert.equal(aligned.status, "WOULD_CREATE");
    for (const content of [
      // A mapping under packages, whose sequence is not the package list.
      "packages:\n  include:\n    - 'domains/*/api'\n",
      // Items at different indentations: a nested sequence.
      "packages:\n  - 'tools/*'\n    - 'domains/*/api'\n",
      // Something other than an item under the key.
      "packages:\n  - 'domains/*/api'\n  exclude: 'x'\n",
    ]) {
      const result = await run(content);
      assert.equal(result.status, "CONFLICT", content);
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"], content);
    }
  });

  it("keeps commas inside quotes and braces of a YAML flow list", async () => {
    for (const content of [
      "packages: ['{domains,tools}/*/api']\n",
      'packages: ["tools/*", \'{domains,other}/*/api\', "!tools/legacy"]\n',
    ]) {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        ...member(),
      });
      const result = await initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
      assert.equal(result.status, "WOULD_CREATE", content);
      assert.equal(result.detections.packageManager, "pnpm", content);
    }
  });

  it("reads a multiline YAML flow list and refuses one that never closes", async () => {
    const run = async (content: string) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        ...member(),
      });
      return initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    for (const content of [
      "packages: [\n  'tools/*',\n  '{domains,other}/*/api',\n]\n",
      "packages: ['tools/*',\n  \"{domains,other}/*/api\" # members\n  ]\nother: 1\n",
    ]) {
      const result = await run(content);
      assert.equal(result.status, "WOULD_CREATE", content);
      assert.equal(result.detections.packageManager, "pnpm", content);
    }
    const open = await run("packages: [\n  'domains/*/api',\n");
    assert.equal(open.status, "CONFLICT");
    assert.deepEqual(open.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"]);
  });

  it("bounds workspace patterns before compiling them", async () => {
    const run = async (patterns: string[]) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": `packages:\n${patterns.map((entry) => `  - '${entry}'`).join("\n")}\n`,
        "pnpm-lock.yaml": "",
        ...member(),
      });
      return initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    const hostile = [
      `${"{a,".repeat(5_000)}x${"}".repeat(5_000)}`,
      `${"**/".repeat(200)}api`,
      "*".repeat(300),
      // Forty alternations of two branches: 2^40 paths for a backtracking matcher.
      `${"{a,a}".repeat(40)}/api`,
      // Nested deeper than the limit.
      `${"{a,".repeat(9)}x${"}".repeat(9)}/*/api`,
    ];
    for (const pattern of hostile) {
      const started = performance.now();
      const result = await run(["domains/*/api", pattern]);
      assert.equal(result.status, "CONFLICT", pattern.slice(0, 40));
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"], pattern.slice(0, 40));
      // Generous: the point is that it ends, not how fast.
      assert(performance.now() - started < 10_000, pattern.slice(0, 40));
    }
    // Ordinary nesting and wildcards stay inside the limits.
    const ordinary = await run(["{apps,{domains,tools}}/*/api"]);
    assert.equal(ordinary.status, "WOULD_CREATE");
    assert.equal(ordinary.detections.packageManager, "pnpm");
  });

  it("stops at the nearest pnpm-workspace.yaml even when it does not select the package", async () => {
    const base = await tree({
      ...rootFiles,
      // A nearer workspace that does not include the package: pnpm does not look further out.
      "domains/pnpm-workspace.yaml": "packages:\n  - 'other/*'\n",
      ...member(),
    });
    const result = await initializeRepository(path.join(base, "domains", "x", "api"), {
      dryRun: true,
      testCommand: { executable: "bun", arguments: ["test"] },
    });
    assert.equal(result.status, "CONFLICT");
    assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"]);
  });

  it("decodes quoted YAML scalars and refuses escapes it does not understand", async () => {
    const run = async (packageDirectory: string, content: string) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        [`${packageDirectory}/package.json`]: JSON.stringify({ name: "api" }),
        [`${packageDirectory}/a.spec.ts`]: BUN_SPEC,
      });
      return initializeRepository(path.join(base, ...packageDirectory.split("/")), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    // A doubled single quote stands for one quote, in block and flow lists, and a comma after it
    // does not split the item.
    for (const [directory, content] of [
      ["domains/it's", "packages:\n  - 'domains/it''s'\n"],
      ["domains/it's", "packages: ['domains/it''s']\n"],
      ["domains/a'b, c", "packages: ['domains/a''b, c', 'other/*']\n"],
      ["domains/it's", 'packages: ["domains/it\'s"]\n'],
    ] as const) {
      const result = await run(directory, content);
      assert.equal(result.status, "WOULD_CREATE", content);
      assert.equal(result.detections.packageManager, "pnpm", content);
    }
    // The undecoded spelling is another directory: it is not selected by the decoded pattern.
    const literal = await run("domains/it''s", "packages:\n  - 'domains/it''s'\n");
    assert.equal(literal.status, "CONFLICT");
    assert.deepEqual(literal.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"]);
    // A double-quoted escape other than the ones a pattern can hold declares nothing.
    for (const content of [
      'packages: ["domains/a\\nb"]\n',
      'packages:\n  - "domains/\\u0061pi"\n',
    ]) {
      const result = await run("domains/api", content);
      assert.equal(result.status, "CONFLICT", content);
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"], content);
    }
  });

  it("refuses package entries that are not strings", async () => {
    const run = async (content: string) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        ...member(),
      });
      return initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    for (const content of [
      "packages: ['domains/*/api']\n",
      "packages: ['domains/*/api',]\n",
      "packages:\n  - 'domains/*/api'\n  - '42'\n  - \"true\"\n",
    ]) {
      const result = await run(content);
      assert.equal(result.status, "WOULD_CREATE", content);
    }
    for (const content of [
      "packages: ['domains/*/api', 42]\n",
      "packages: ['domains/*/api', true]\n",
      "packages: ['domains/*/api', null]\n",
      "packages: ['domains/*/api', ~]\n",
      "packages: ['domains/*/api', 1.5]\n",
      "packages: ['domains/*/api', , 'tools/*']\n",
      "packages: ['domains/*/api', {a: b}]\n",
      "packages: ['domains/*/api', [nested]]\n",
      "packages:\n  - 'domains/*/api'\n  - 7\n",
      "packages:\n  - 'domains/*/api'\n  - false\n",
      "packages:\n  - 'domains/*/api'\n  -\n",
      "packages:\n  - 'domains/*/api'\n  - key: value\n",
    ]) {
      const result = await run(content);
      assert.equal(result.status, "CONFLICT", content);
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"], content);
    }
  });

  it("reads a quoted packages key and refuses a repeated key", async () => {
    const run = async (content: string) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        ...member(),
      });
      return initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    for (const content of [
      "'packages': ['domains/*/api']\n",
      "\"packages\": ['domains/*/api']\n",
      "'packages':\n  - 'domains/*/api'\n",
      '"packages" :\n  - "domains/*/api"\n',
      "catalog:\n  a: 1\npackages: ['domains/*/api']\n",
    ]) {
      const result = await run(content);
      assert.equal(result.status, "WOULD_CREATE", content);
    }
    for (const content of [
      "packages: ['domains/*/api']\npackages: ['tools/*']\n",
      "packages:\n  - 'domains/*/api'\npackages:\n  - 'tools/*'\n",
      "packages: ['domains/*/api']\n'packages': ['tools/*']\n",
      '"packages":\n  - "domains/*/api"\npackages: []\n',
      "packages: ['domains/*/api']\ncatalog:\n  a: 1\ncatalog:\n  b: 2\n",
      // The key is spelled with an escape: not read, so nothing is declared.
      "\"pack\\u0061ges\": ['domains/*/api']\n",
    ]) {
      const result = await run(content);
      assert.equal(result.status, "CONFLICT", content);
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"], content);
    }
  });

  it("refuses YAML that its parser would refuse", async () => {
    const run = async (content: string) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        ...member(),
      });
      return initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    for (const content of [
      "---\npackages: ['domains/*/api']\n",
      "packages: ['domains/*/api']\n...\n",
      "packages: ['domains/*/api', 'it''s']\n",
      'packages: [\'domains/*/api\', "say \\"x\\""]\n',
    ]) {
      const result = await run(content);
      assert.equal(result.status, "WOULD_CREATE", content);
    }
    for (const content of [
      // An unescaped quote inside a quoted scalar ends it: what follows is not valid YAML.
      "packages: ['domains/*/api', 'a'b']\n",
      'packages: [\'domains/*/api\', "a"b"]\n',
      "packages:\n  - 'domains/*/api'\n  - 'a'b'\n",
      // A top-level line that is not a mapping entry invalidates the file, before or after.
      "packages: ['domains/*/api']\nthis is invalid\n",
      "this is invalid\npackages: ['domains/*/api']\n",
      "packages:\n  - 'domains/*/api'\nnot a mapping entry\n",
    ]) {
      const result = await run(content);
      assert.equal(result.status, "CONFLICT", content);
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"], content);
    }
  });

  it("refuses a malformed value of a key it does not read", async () => {
    const run = async (content: string) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        ...member(),
      });
      return initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    const packages = "packages: ['domains/*/api']\n";
    for (const content of [
      `${packages}catalog: [a, b]\n`,
      `${packages}catalog: {a: b}\n`,
      `${packages}name: 'it''s'\n`,
      `${packages}catalog: [\n  a,\n  b\n]\n`,
      `${packages}catalog:\n  foo: '1.0'\n  bar: [x, y]\n`,
      `${packages}catalog:\n  - [a, b]\n  - "c"\n`,
      `${packages}note: it's [fine\n`,
      `${packages}catalog: {a: [b], c: {d: e}}\n`,
      // A block sequence at the column of its key is that key's value.
      `catalog:\n- a\n- b\n${packages}`,
      "packages:\n- 'domains/*/api'\n",
    ]) {
      const result = await run(content);
      assert.equal(result.status, "WOULD_CREATE", content);
    }
    for (const content of [
      `${packages}catalog: [\n`,
      `${packages}catalog: {a: b\n`,
      `${packages}catalog: 'abc\n`,
      `${packages}catalog: "abc\n`,
      `${packages}catalog: 'a' b\n`,
      `${packages}catalog: [a] b\n`,
      `${packages}catalog:\n  foo: [\n`,
      `${packages}catalog:\n  - 'abc\n`,
      `catalog: [\n${packages}`,
      // A closing bracket must be the one its opener asks for.
      `catalog: [}\n${packages}`,
      `${packages}catalog: {a: [b}]\n`,
      `${packages}catalog: [a, {b: c]}\n`,
      // YAML folds a break inside a scalar to one space and drops the indentation; the file is
      // not read rather than matched on its raw lines.
      "packages: [\n  'domains/*/api',\n  \"other/\n    dir\"\n]\n",
      "packages: [\n  'domains/*/api',\n  tools/\n    x\n]\n",
      "packages: ['domains/*/api', \"a,\n b\"]\n",
      // A tab in the indentation is not valid YAML.
      "packages:\n\t- 'domains/*/api'\n",
      "packages:\n  \t- 'domains/*/api'\n",
      "\tpackages: ['domains/*/api']\n",
      // Whitespace other than space and tab is content in YAML, not separation: the file is
      // not read rather than trimmed into a different pattern.
      "packages:\n  - 'domains/*/api'\n  - domains/x \n",
      "packages: ['domains/*/api'] \n",
      "packages: \n  - 'domains/*/api'\n",
      // Nothing may sit left of the root mapping's column.
      "  packages: ['domains/*/api']\ncatalog: x\n",
      "    packages: ['domains/*/api']\n  other: x\n",
      // A root mapping cannot turn into a sequence.
      `${packages}- invalid\n`,
      `${packages}catalog: x\n- a\n`,
      `${packages}catalog:\n  a: 1\n- b\n`,
    ]) {
      const result = await run(content);
      assert.equal(result.status, "CONFLICT", content);
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"], content);
    }
  });

  it("does not infer a manager from a lockfile it cannot read as a file", async () => {
    const run = async (extra: Record<string, string>) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": "packages: ['domains/*/api']\n",
        ...extra,
        ...member(),
      });
      return initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    assert.equal((await run({ "pnpm-lock.yaml": "" })).status, "WOULD_CREATE");
    // A directory where a manager's lockfile belongs is still that manager's path.
    for (const entry of ["package-lock.json/", "yarn.lock/", "bun.lock/"]) {
      const result = await run({ "pnpm-lock.yaml": "", [entry]: "" });
      assert.equal(result.status, "CONFLICT", entry);
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"], entry);
    }
  });

  it("skips a byte-order mark and redundant separators", async () => {
    const run = async (content: string) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        ...member(),
      });
      return initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    for (const content of [
      "﻿packages: ['domains/*/api']\n",
      "﻿packages:\n  - 'domains/*/api'\n",
      // A line break between flow items is separation; one inside a scalar is not read.
      "packages: [\n  'domains/*/api',\n  'tools/*'\n]\n",
      "packages: [\n  'domains/*/api',\n  'tools/*',\n]\n",
      // Only `-` followed by white space is a sequence marker: `-foo` is a plain key.
      "packages: ['domains/*/api']\n-foo: bar\n",
      "-foo: bar\npackages: ['domains/*/api']\n",
      "packages:\n  - 'domains/*/api'\n-foo: bar\n",
      // A tab separates tokens, it does not indent.
      "packages:\t['domains/*/api']\n",
      "packages:\n  - 'domains/*/api'\t# comment\n",
      // YAML lines end with `\r`, `\n` or `\r\n`.
      "packages:\r  - 'domains/*/api'\r",
      "packages: ['domains/*/api']\r",
      "catalog:\r  a: 1\rpackages:\r\n  - 'domains/*/api'\n",
      // A document may indent its whole root mapping.
      "  packages:\n    - 'domains/*/api'\n",
      "  packages: ['domains/*/api']\n  catalog:\n    a: 1\n",
      "---\n  packages: ['domains/*/api']\n",
      "  packages:\n  - 'domains/*/api'\n",
      "packages: ['domains//x/api']\n",
      "packages: ['domains/*//api']\n",
      "packages: ['domains/x/api//']\n",
      "packages: ['./domains//x/./api']\n",
      // Parent segments are normalized, and a pattern that climbs out of the root is ignored.
      "packages: ['domains/y/../x/api']\n",
      "packages: ['domains/*/../x/api']\n",
      "packages: ['tools/../domains/x/api']\n",
      "packages:\n  - '../outside/*'\n  - 'domains/*/api'\n",
      "packages: ['domains/{x,y}//api']\n",
      "packages: ['domains/**//api']\n",
    ]) {
      const result = await run(content);
      assert.equal(result.status, "WOULD_CREATE", content);
    }
  });

  it("never selects a directory below a dependency tree", async () => {
    const run = async (directory: string, content: string) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        [`${directory}/package.json`]: JSON.stringify({ name: "dep" }),
        [`${directory}/a.spec.ts`]: BUN_SPEC,
      });
      return initializeRepository(path.join(base, ...directory.split("/")), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    for (const [directory, content] of [
      ["node_modules/dep", "packages:\n  - '**'\n"],
      ["node_modules/dep", "packages:\n  - 'node_modules/*'\n"],
      ["packages/a/node_modules/dep", "packages:\n  - 'packages/**'\n"],
      ["bower_components/dep", "packages:\n  - 'bower_components/*'\n"],
      ["packages/bower_components/dep", "packages:\n  - 'packages/*/*'\n"],
    ] as const) {
      const result = await run(directory, content);
      assert.equal(result.status, "CONFLICT", `${directory} ${content}`);
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"], content);
    }
    // A name that only contains the word is an ordinary directory.
    const result = await run("packages/my_node_modules", "packages:\n  - 'packages/*'\n");
    assert.equal(result.status, "WOULD_CREATE");
  });

  it("says the manager was inherited on results that stop early too", async () => {
    const base = await tree({
      ".git/": "",
      "pnpm-workspace.yaml": "packages: ['domains/*/api']\n",
      "pnpm-lock.yaml": "",
      // A package with no test source: the framework is undetected and the run stops there.
      "domains/x/api/package.json": JSON.stringify({ name: "api" }),
    });
    const result = await initializeRepository(path.join(base, "domains", "x", "api"), {
      dryRun: true,
    });
    assert.equal(result.status, "CONFLICT");
    assert.equal(result.detections.packageManager, "pnpm");
    assert.deepEqual(result.reasonCodes, [
      "FRAMEWORK_UNDETECTED",
      "PACKAGE_MANAGER_FROM_WORKSPACE_ROOT",
    ]);
  });

  it("does not let a member with an unusable packageManager inherit its workspace's", async () => {
    const run = async (field: unknown) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": "packages: ['domains/*/api']\n",
        "pnpm-lock.yaml": "",
        ...member({ packageManager: field }),
      });
      return initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    for (const field of [42, true, null, { name: "pnpm" }, ["pnpm@12"]]) {
      const result = await run(field);
      assert.equal(result.status, "CONFLICT", JSON.stringify(field));
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_INVALID"], JSON.stringify(field));
    }
    // Absent, the member inherits as before.
    assert.equal((await run(undefined)).status, "WOULD_CREATE");
  });

  it("refuses a workspace root packageManager that is not a string", async () => {
    const run = async (field: unknown) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": "packages: ['domains/*/api']\n",
        "package.json": JSON.stringify({ name: "root", packageManager: field }),
        ...member(),
      });
      return initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    for (const field of [42, true, null, { name: "pnpm" }, ["pnpm@12"]]) {
      const result = await run(field);
      assert.equal(result.status, "CONFLICT", JSON.stringify(field));
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_INVALID"], JSON.stringify(field));
    }
    assert.equal((await run("pnpm@12.11.2")).status, "WOULD_CREATE");
  });

  it("reads braces held in a character class as characters", async () => {
    const run = async (directory: string, content: string) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        [`${directory}/package.json`]: JSON.stringify({ name: "api" }),
        [`${directory}/a.spec.ts`]: BUN_SPEC,
      });
      return initializeRepository(path.join(base, ...directory.split("/")), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    for (const [directory, content] of [
      ["domains/{/api", "packages:\n  - 'domains/[{}]/api'\n"],
      ["domains/}/api", "packages:\n  - 'domains/[{}]/api'\n"],
      ["domains/{/api", "packages:\n  - 'domains/{[{}],z}/api'\n"],
      ["domains/z/api", "packages:\n  - 'domains/{[{}],z}/api'\n"],
      // Braces in a class are characters: they do not count towards the nesting bound.
      ["domains/{/api", "packages:\n  - 'domains/[{{{{{{{{{{{{]/api'\n"],
    ] as const) {
      const result = await run(directory, content);
      assert.equal(result.status, "WOULD_CREATE", `${directory} ${content}`);
    }
    const refused = await run("domains/x/api", "packages:\n  - 'domains/[{}]/api'\n");
    assert.equal(refused.status, "CONFLICT");
    assert.deepEqual(refused.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"]);
  });

  it("does not let a wildcard select a dot-prefixed directory", async () => {
    const run = async (directory: string, content: string) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        [`${directory}/package.json`]: JSON.stringify({ name: "api" }),
        [`${directory}/a.spec.ts`]: BUN_SPEC,
      });
      return initializeRepository(path.join(base, ...directory.split("/")), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    for (const [directory, content] of [
      ["packages/.hidden", "packages:\n  - 'packages/*'\n"],
      ["packages/.hidden", "packages:\n  - 'packages/?hidden'\n"],
      ["packages/.hidden", "packages:\n  - 'packages/[a-z]hidden'\n"],
      ["packages/.hidden/api", "packages:\n  - 'packages/**'\n"],
    ] as const) {
      const result = await run(directory, content);
      assert.equal(result.status, "CONFLICT", content);
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"], content);
    }
    // A pattern that spells the dot selects it, and an ordinary directory is still selected.
    for (const [directory, content] of [
      ["packages/.hidden", "packages:\n  - 'packages/.hidden'\n"],
      ["packages/.hidden", "packages:\n  - 'packages/.*'\n"],
      ["packages/.hidden", "packages:\n  - 'packages/[.]hidden'\n"],
      // Any leading class that can match a dot spells it.
      ["packages/.hidden", "packages:\n  - 'packages/[.a]hidden'\n"],
      ["packages/.hidden", "packages:\n  - 'packages/[a.]hidden'\n"],
      ["packages/.hidden", "packages:\n  - 'packages/[.-0]hidden'\n"],
      ["packages/a", "packages:\n  - 'packages/*'\n"],
      ["packages/a/b", "packages:\n  - 'packages/**'\n"],
    ] as const) {
      const result = await run(directory, content);
      assert.equal(result.status, "WOULD_CREATE", content);
    }
  });

  it("counts nesting of braces, not sibling groups", async () => {
    // Nine sibling groups: 2^9 = 512 alternations, nesting depth one.
    const base = await tree({
      ".git/": "",
      "pnpm-workspace.yaml":
        "packages:\n  - '{d,e}{o,p}{m,n}{a,b}{i,j}{n,o}{s,t}/{x,y}/{api,web}'\n",
      "pnpm-lock.yaml": "",
      ...member(),
    });
    const result = await initializeRepository(path.join(base, "domains", "x", "api"), {
      dryRun: true,
      testCommand: { executable: "bun", arguments: ["test"] },
    });
    assert.equal(result.status, "WOULD_CREATE");
    assert.equal(result.detections.packageManager, "pnpm");
  });

  it("keeps a # inside a quoted pattern and rejects text after a flow list", async () => {
    const packageDirectory = "domains/api #1";
    const run = async (content: string) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        [`${packageDirectory}/package.json`]: JSON.stringify({ name: "api" }),
        [`${packageDirectory}/a.spec.ts`]: BUN_SPEC,
      });
      return initializeRepository(path.join(base, ...packageDirectory.split("/")), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    for (const content of [
      "packages:\n  - 'domains/api #1'\n",
      "packages: ['domains/api #1'] # trailing comment\n",
      "packages: [\"domains/api #1\", 'x']\n",
      "packages: [\n  'domains/api #1' # the package\n]\n",
    ]) {
      const result = await run(content);
      assert.equal(result.status, "WOULD_CREATE", content);
      assert.equal(result.detections.packageManager, "pnpm", content);
    }
    for (const content of [
      "packages: ['domains/*'] trailing\n",
      "packages: [\n  'domains/*'\n] trailing\n",
    ]) {
      const result = await run(content);
      assert.equal(result.status, "CONFLICT", content);
      assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"], content);
    }
  });

  it("reads a workspace manifest beyond the YAML bound and keeps unreadable apart from invalid", async () => {
    const run = async (megabytes: number) => {
      const base = await tree({
        ...rootFiles,
        "package.json": JSON.stringify({
          name: "root",
          packageManager: "pnpm@12.11.2",
          padding: "x".repeat(megabytes * 1_048_576),
        }),
        ...member(),
      });
      return initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
    };
    // A valid manifest larger than the 1 MiB YAML bound is still a manifest.
    const large = await run(2);
    assert.equal(large.status, "WOULD_CREATE");
    assert.equal(large.detections.packageManager, "pnpm");
    // Beyond its own bound it infers nothing, and is not reported as malformed JSON.
    const huge = await run(17);
    assert.equal(huge.status, "CONFLICT");
    assert.deepEqual(huge.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"]);
  });

  it("matches wildcard runs without backtracking", { timeout: 60_000 }, async () => {
    // Eight `*a` groups against a directory of one hundred and twenty `a`: polynomial of degree 8
    // for a backtracking regular expression, which never ends; a product of lengths here.
    const directory = "a".repeat(120);
    const base = await tree({
      ".git/": "",
      "pnpm-workspace.yaml": `packages:\n  - 'domains/${"*a".repeat(8)}*b/api'\n`,
      "pnpm-lock.yaml": "",
      [`domains/${directory}/api/package.json`]: JSON.stringify({ name: "api" }),
      [`domains/${directory}/api/a.spec.ts`]: BUN_SPEC,
    });
    const started = performance.now();
    const result = await initializeRepository(path.join(base, "domains", directory, "api"), {
      dryRun: true,
      testCommand: { executable: "bun", arguments: ["test"] },
    });
    assert.equal(result.status, "CONFLICT");
    assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"]);
    assert(performance.now() - started < 10_000);
  });

  it("reads a large hostile pnpm-workspace.yaml in linear time", { timeout: 60_000 }, async () => {
    const run = async (content: string) => {
      const base = await tree({
        ".git/": "",
        "pnpm-workspace.yaml": content,
        "pnpm-lock.yaml": "",
        ...member(),
      });
      const started = performance.now();
      const result = await initializeRepository(path.join(base, "domains", "x", "api"), {
        dryRun: true,
        testCommand: { executable: "bun", arguments: ["test"] },
      });
      return { result, elapsed: performance.now() - started };
    };
    const cases = [
      // A flow list of ~60,000 lines that never closes: rescanned per line, it is quadratic.
      `packages: [\n${"  'x/*',\n".repeat(60_000)}`,
      // The same list closed, far beyond the pattern budget.
      `packages: [\n${"  'x/*',\n".repeat(60_000)}]\n`,
      // Whitespace runs that make comment and item expressions backtrack.
      `packages:\n  -${" ".repeat(900_000)}\n  - 'domains/*/api' ${" ".repeat(50_000)}\n`,
      `packages:\n${" ".repeat(900_000)}x\n  - 'domains/*/api'\n`,
    ];
    for (const content of cases) {
      const { result, elapsed } = await run(content);
      assert.equal(result.status === "WOULD_CREATE" || result.status === "CONFLICT", true);
      assert(elapsed < 20_000, `${elapsed} ms for ${content.slice(0, 30)}`);
    }
    // A flow list that closes after many lines is read once and still selects the member.
    const closed = await run(`packages: [\n${"  'x/*',\n".repeat(200)}  'domains/*/api'\n]\n`);
    assert.equal(closed.result.status, "WOULD_CREATE");
    assert.equal(closed.result.detections.packageManager, "pnpm");
  });

  it("does not read package.json workspaces when pnpm-workspace.yaml cannot be read", async () => {
    const base = await tree({
      ".git/": "",
      // Larger than the 1 MiB read limit: it exists, so pnpm would still read it.
      "pnpm-workspace.yaml": `packages:\n  - 'domains/*/api'\n# ${"x".repeat(1_048_700)}\n`,
      "package.json": JSON.stringify({ name: "root", workspaces: ["domains/*/api"] }),
      "package-lock.json": "{}\n",
      ...member(),
    });
    const result = await initializeRepository(path.join(base, "domains", "x", "api"), {
      dryRun: true,
      testCommand: { executable: "bun", arguments: ["test"] },
    });
    assert.equal(result.status, "CONFLICT");
    assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"]);
  });

  it("reads only pnpm-workspace.yaml once it exists, as pnpm does", async () => {
    const base = await tree({
      ".git/": "",
      "pnpm-workspace.yaml": "packages:\n  - 'other/*'\n",
      "pnpm-lock.yaml": "",
      "package.json": JSON.stringify({
        name: "root",
        packageManager: "pnpm@12.11.2",
        workspaces: ["domains/*/api"],
      }),
      ...member(),
    });
    const result = await initializeRepository(path.join(base, "domains", "x", "api"), {
      dryRun: true,
      testCommand: { executable: "bun", arguments: ["test"] },
    });
    assert.equal(result.status, "CONFLICT");
    assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_UNDETECTED"]);
  });

  it("revalidates the workspace facts it inherited before writing anything", async () => {
    const base = await tree({ ...rootFiles, ...member() });
    const memberRoot = path.join(base, "domains", "x", "api");
    const result = await initializeRepository(memberRoot, {
      testCommand: { executable: "bun", arguments: ["test"] },
      afterEvidenceSnapshot: async () => {
        await writeFile(
          path.join(base, "package.json"),
          JSON.stringify({ name: "root", packageManager: "yarn@4.0.0" }),
        );
      },
    });
    assert.equal(result.status, "CONFLICT");
    assert.deepEqual(result.reasonCodes, ["REPOSITORY_CHANGED_DURING_INIT"]);
    assert.deepEqual((await readdir(memberRoot)).sort(), ["a.spec.ts", "package.json"]);
  });

  it("reports conflicting root facts instead of choosing one", async () => {
    const base = await tree({
      ...rootFiles,
      "package.json": JSON.stringify({ name: "root", packageManager: "yarn@4.0.0" }),
      ...member(),
    });
    const result = await initializeRepository(path.join(base, "domains", "x", "api"), {
      dryRun: true,
      testCommand: { executable: "bun", arguments: ["test"] },
    });
    assert.equal(result.status, "CONFLICT");
    assert.deepEqual(result.reasonCodes, ["PACKAGE_MANAGER_AMBIGUOUS"]);
  });
});

describe("a command that does not run the framework directly is named as such", () => {
  async function blocked(script: string, framework: "bun:test" | "node:test") {
    const source =
      framework === "bun:test"
        ? BUN_SPEC
        : 'import test from "node:test";\ntest("one", () => {});\n';
    const root = await tree({
      "package.json": JSON.stringify({
        name: "root",
        packageManager: "pnpm@12.11.2",
        scripts: { test: script },
      }),
      "pnpm-lock.yaml": "",
      "a/one.test.ts": source,
      "b/two.test.ts": source,
    });
    return { root, ...(await doctorJson([root, "--framework", framework], root)) };
  }

  for (const [script, framework, executable] of [
    ["turbo test test:repository", "bun:test", "turbo"],
    ["pnpm -r test", "node:test", "pnpm"],
    ["bun run test", "bun:test", "bun"],
    // A script of its own run by node, not Node's test runner.
    ["node runner", "node:test", "node"],
    // `--test` after the entry point belongs to that program, not to node.
    ["node runner --test", "node:test", "node"],
    ["node --no-warnings runner --test", "node:test", "node"],
    ["node runner.js --test", "node:test", "node"],
    ["tsx runner --test", "node:test", "tsx"],
    // `bun test` is an argument of the script here, not the runner.
    ["node runner bun test", "bun:test", "node"],
    // A test-runner switch takes no value: the word after it is the entry point.
    ["node --test-only runner --test", "node:test", "node"],
    // `echo` only prints `bun test`: it is neither Bun nor a launcher of Bun.
    ["echo bun test", "bun:test", "echo"],
    // After `run` the next word is a script name, whatever it is called.
    ["npm run bun test", "bun:test", "npm"],
    ["pnpm run bun test", "bun:test", "pnpm"],
    ["pnpm bun test", "bun:test", "pnpm"],
    ["yarn run bun test", "bun:test", "yarn"],
    // The program after the launcher is `echo`, which only prints the rest.
    ["pnpm exec echo bun test", "bun:test", "pnpm"],
    ["env CI=1 echo bun test", "bun:test", "env"],
    // `--` ends Node's options: `--test` after it is a script name.
    ["node -- --test", "node:test", "node"],
    // The command must be a runtime or one of its launchers, not a program that prints them.
    ["echo node --test", "node:test", "echo"],
    // The launcher dispatches `echo`: the `node` after it is one of its arguments.
    ["npm exec -- echo node --test", "node:test", "npm"],
    ["pnpm exec echo node --test", "node:test", "pnpm"],
    ["env CI=1 echo node --test", "node:test", "env"],
    // `corepack` only dispatches to a package manager, and Bun's `-e` takes code, not a command.
    ["corepack bun test", "bun:test", "corepack"],
    ["bun -e test", "bun:test", "bun"],
    // `exec` is the value of `--workspace` here: the manager has no subcommand and runs a script.
    ["npm --workspace exec node --test", "node:test", "npm"],
    ["npm -w exec bun test", "bun:test", "npm"],
    ["bun --unknown-option test", "bun:test", "bun"],
    // A runtime spelled as a path is still the runtime that was given a script.
    // From a script, the program that owns `--test` must be a Node runtime.
    ["echo --test", "node:test", "echo"],
    ["pnpm exec echo --test", "node:test", "pnpm"],
    // After `run`, `node` is the name of a package script, not a program.
    ["npm run node --test", "node:test", "npm"],
    ["pnpm run node --test", "node:test", "pnpm"],
    ["pnpm node --test", "node:test", "pnpm"],
    ["yarn run tsx --test", "node:test", "yarn"],
    // Bun only takes `--cwd=dir` before its subcommand: the separate value is not understood.
    ["bun --cwd api test", "bun:test", "bun"],
    ["./node runner --test", "node:test", "./node"],
    ["tools/node runner --test", "node:test", "tools/node"],
  ] as const) {
    it(`blocks \`${script}\` with TEST_COMMAND_INDIRECT, not a missing-tests code`, async () => {
      const { code, result } = await blocked(script, framework);
      assert.equal(code, 3);
      assert.equal(result.status, "BLOCKED");
      assert.deepEqual(result.reasonCodes, ["TEST_COMMAND_INDIRECT"]);
      assert.equal(result.detections.testCommand.executable, executable);
    });
  }

  for (const framework of ["bun:test", "node:test"] as const) {
    it(`does not let a task name select the ${framework} tests of a directory of that name`, async () => {
      const source =
        framework === "bun:test"
          ? BUN_SPEC
          : 'import test from "node:test";\ntest("one", () => {});\n';
      const root = await tree({
        "package.json": JSON.stringify({
          name: "root",
          packageManager: "pnpm@12.11.2",
          scripts: { test: "turbo test" },
        }),
        "pnpm-lock.yaml": "",
        "test/one.test.ts": source,
        "other/two.test.ts": source,
      });
      const { code, result } = await doctorJson([root, "--framework", framework], root);
      assert.equal(code, 3);
      assert.equal(result.status, "BLOCKED");
      assert.deepEqual(result.reasonCodes, ["TEST_COMMAND_INDIRECT"]);
      assert.deepEqual(result.files, []);
    });
  }

  for (const [script, framework] of [
    ["pnpm exec node --test tests", "node:test"],
    ["tsx --test tests", "node:test"],
    ["npx tsx --test tests", "node:test"],
    ["node --import tsx --test tests", "node:test"],
    ["node --test-name-pattern unit --test tests", "node:test"],
    ["node --test-rerun-failures state.json --test tests", "node:test"],
    ["node --experimental-test-isolation process --test tests", "node:test"],
    ["node --test-reporter spec --test-concurrency 2 --test tests", "node:test"],
    ["pnpm exec bun test tests", "bun:test"],
    ["pnpm --filter api exec bun test tests", "bun:test"],
    ["npm exec -- bun test tests", "bun:test"],
    ["npx bun test tests", "bun:test"],
    ["npx --package bun bun test tests", "bun:test"],
    ["npx -p bun bun test tests", "bun:test"],
    // The value of a launcher's option is not the program that owns `--test`.
    ["c8 node --test tests", "node:test"],
    ["cross-env NODE_ENV=test node --test tests", "node:test"],
    ["corepack pnpm exec node --test tests", "node:test"],
    ["npx --package tsx tsx --test tests", "node:test"],
    ["npx -p tsx tsx --test tests", "node:test"],
    ["pnpx tsx --test tests", "node:test"],
    ["pnpx bun test tests", "bun:test"],
    ["bun --expose-gc test tests", "bun:test"],
    ["bun --conditions=development test tests", "bun:test"],
    ["pnpm --filter api exec node --test tests", "node:test"],
    ["npm --workspace api exec -- node --test tests", "node:test"],
    ["env -u FOO bun test tests", "bun:test"],
    ["env --unset=FOO CI=1 bun test tests", "bun:test"],
    ["env -C . bun test tests", "bun:test"],
    ["bun --smol test tests", "bun:test"],
    ["bun --cwd=packages/api test tests", "bun:test"],
    ["npm exec -- node --test tests", "node:test"],
    ["npx -- tsx --test tests", "node:test"],
    ["pnpm exec bun --bun test tests", "bun:test"],
    ["node --test -- tests", "node:test"],
    ["bunx bun test tests", "bun:test"],
    ["env CI=1 bun test tests", "bun:test"],
    ["corepack pnpm exec bun test tests", "bun:test"],
    ["dotenv -e .env -- bun test tests", "bun:test"],
  ] as const) {
    it(`keeps \`${script}\` as a runner that names a path nothing matches`, async () => {
      const { code, result } = await blocked(script, framework);
      assert.equal(code, 3);
      assert.deepEqual(result.reasonCodes, ["BASE_TEST_FILES_UNAVAILABLE"]);
    });
  }

  it("keeps the Bun subcommand out of the path filters behind a launcher", async () => {
    const root = await tree({
      "package.json": JSON.stringify({
        name: "root",
        packageManager: "pnpm@12.11.2",
        scripts: { test: "pnpm exec bun test missing.spec.ts" },
      }),
      "pnpm-lock.yaml": "",
      "test/one.test.ts": BUN_SPEC,
      "other/two.test.ts": BUN_SPEC,
    });
    const { code, result } = await doctorJson([root, "--framework", "bun:test"], root);
    assert.equal(code, 3);
    assert.equal(result.status, "BLOCKED");
    assert.deepEqual(result.reasonCodes, ["BASE_TEST_FILES_UNAVAILABLE"]);
  });

  it("keeps the launcher words of Node's runner out of the path filters", async () => {
    const source = 'import test from "node:test";\ntest("one", () => {});\n';
    const root = await tree({
      "package.json": JSON.stringify({
        name: "root",
        packageManager: "pnpm@12.11.2",
        scripts: { test: "pnpm exec node --test" },
      }),
      "pnpm-lock.yaml": "",
      // A directory called like the runtime must not become a filter.
      "node/one.test.ts": source,
      "exec/two.test.ts": source,
      "other/three.test.ts": source,
    });
    const result = await initializeRepository(root, { dryRun: true, framework: "node:test" });
    assert.equal(result.status, "WOULD_CREATE");
    const config = JSON.parse(
      result.files.find((file) => file.path === "assertledger.config.json")?.content ?? "null",
    );
    assert.deepEqual([...config.adapter.baseTestFiles].sort(), [
      "exec/two.test.ts",
      "node/one.test.ts",
      "other/three.test.ts",
    ]);
  });

  it("keeps the values of Bun test options out of the path filters", async () => {
    for (const script of [
      "bun test --preload setup/preload.ts",
      "bun test --timeout 5000 --reporter junit --reporter-outfile out/report.xml",
      "pnpm exec bun test -r setup/preload.ts --rerun-each 2",
    ]) {
      const root = await tree({
        "package.json": JSON.stringify({
          name: "root",
          packageManager: "pnpm@12.11.2",
          scripts: { test: script },
        }),
        "pnpm-lock.yaml": "",
        "a/one.test.ts": BUN_SPEC,
        "setup/preload.ts": "export {};\n",
      });
      const result = await initializeRepository(root, { dryRun: true, framework: "bun:test" });
      assert.equal(result.status, "WOULD_CREATE", script);
      const config = JSON.parse(
        result.files.find((file) => file.path === "assertledger.config.json")?.content ?? "null",
      );
      assert.deepEqual(config.adapter.baseTestFiles, ["a/one.test.ts"], script);
    }
  });

  it("takes a declared command for the direct runner, whatever its executable", async () => {
    const root = await tree({
      "package.json": JSON.stringify({
        name: "root",
        packageManager: "pnpm@12.11.2",
        scripts: { test: "echo --test" },
      }),
      "pnpm-lock.yaml": "",
      "one.test.ts": 'import test from "node:test";\ntest("one", () => {});\n',
    });
    // From the script, `echo` is no Node runtime; declared, the operator's command stands.
    const inferred = await initializeRepository(root, { dryRun: true, framework: "node:test" });
    assert.equal(inferred.status, "BLOCKED");
    assert.deepEqual(inferred.reasonCodes, ["TEST_COMMAND_INDIRECT"]);
    const declared = await initializeRepository(root, {
      dryRun: true,
      framework: "node:test",
      testCommand: { executable: "custom-runner", arguments: ["--test"] },
    });
    assert.equal(declared.status, "WOULD_CREATE");
  });

  it("does not read the executable slot as a script given to Node", async () => {
    const root = await tree({
      "package.json": JSON.stringify({ name: "root", packageManager: "pnpm@12.11.2" }),
      "pnpm-lock.yaml": "",
      "one.test.ts": 'import test from "node:test";\ntest("one", () => {});\n',
    });
    for (const executable of ["./node", "tools/node"]) {
      const result = await initializeRepository(root, {
        dryRun: true,
        framework: "node:test",
        testCommand: { executable, arguments: ["--test"] },
      });
      assert.equal(result.status, "WOULD_CREATE", executable);
    }
  });

  it("keeps an unmatched Bun spec file name as a filter, not as no filter", async () => {
    const root = await tree({
      "package.json": JSON.stringify({
        name: "root",
        packageManager: "pnpm@12.11.2",
        scripts: { test: "bun test missing.spec.ts" },
      }),
      "pnpm-lock.yaml": "",
      "a/one.test.ts": BUN_SPEC,
      "b/two.spec.ts": BUN_SPEC,
    });
    const { code, result } = await doctorJson([root, "--framework", "bun:test"], root);
    assert.equal(code, 3);
    assert.deepEqual(result.reasonCodes, ["BASE_TEST_FILES_UNAVAILABLE"]);
  });

  it("keeps a wrapper that names an existing Bun spec file as a path", async () => {
    const root = await tree({
      "package.json": JSON.stringify({
        name: "root",
        packageManager: "pnpm@12.11.2",
        scripts: { test: "custom-runner one.spec.ts" },
      }),
      "pnpm-lock.yaml": "",
      "one.spec.ts": BUN_SPEC,
      "other.spec.ts": BUN_SPEC,
    });
    const result = await initializeRepository(root, { dryRun: true, framework: "bun:test" });
    assert.equal(result.status, "WOULD_CREATE");
    const config = JSON.parse(
      result.files.find((file) => file.path === "assertledger.config.json")?.content ?? "null",
    );
    assert.deepEqual(config.adapter.baseTestFiles, ["one.spec.ts"]);
  });

  it("still reports missing tests when the runner itself names a path nothing matches", async () => {
    const root = await tree({
      "package.json": JSON.stringify({
        name: "root",
        packageManager: "pnpm@12.11.2",
        scripts: { test: "bun test tests" },
      }),
      "pnpm-lock.yaml": "",
      "a/one.test.ts": BUN_SPEC,
    });
    const { result } = await doctorJson([root, "--framework", "bun:test"], root);
    assert.deepEqual(result.reasonCodes, ["BASE_TEST_FILES_UNAVAILABLE"]);

    const wrapped = await tree({
      "package.json": JSON.stringify({
        name: "root",
        packageManager: "pnpm@12.11.2",
        scripts: { test: "turbo run test -- missing/*.test.ts" },
      }),
      "pnpm-lock.yaml": "",
      "a/one.test.ts": BUN_SPEC,
    });
    const named = await doctorJson([wrapped, "--framework", "bun:test"], wrapped);
    assert.deepEqual(named.result.reasonCodes, ["BASE_TEST_FILES_UNAVAILABLE"]);
  });

  it("is cleared by the direct runner command the diagnostic points to", async () => {
    const { root } = await blocked("turbo test test:repository", "bun:test");
    const commandPath = path.join(root, "bun-test.json");
    await writeFile(commandPath, JSON.stringify({ executable: "bun", arguments: ["test"] }));
    const repaired = await doctorJson(
      [root, "--framework", "bun:test", "--test-command-json", commandPath],
      root,
    );
    assert.equal(repaired.code, 0);
    assert.equal(repaired.result.status, "WOULD_CREATE");
  });
});
