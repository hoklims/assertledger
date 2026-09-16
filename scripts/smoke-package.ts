#!/usr/bin/env node
/** Exercise the packed distribution from a fresh, disposable consumer. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = realpathSync(path.resolve(fileURLToPath(import.meta.url), "..", ".."));
const runId = randomUUID();
const artifactRoot = path.join(ROOT, ".testforge", "package-smoke");
const artifacts = path.join(artifactRoot, runId);
const required = [
  "package.json",
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/sdk/index.js",
  "dist/sdk/index.d.ts",
  "dist/core/index.js",
  "dist/core/index.d.ts",
  "dist/engine/node-test-reporter.js",
  "README.md",
  "README.fr.md",
  "docs/reference.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "examples/node-test/request.json",
  "examples/node-test/repository/package.json",
  "examples/node-test/repository/src/is-even.js",
  "examples/node-test/repository/tests/base.test.js",
  "examples/agentic-profile/profile-manifest.mjs",
  "examples/evidence-export/consumer.mjs",
  "examples/git-history/create-demo.mjs",
  "examples/git-history/escape-string-regexp/before.cjs.txt",
  "examples/git-history/escape-string-regexp/fixed.cjs.txt",
  "examples/git-history/escape-string-regexp/provenance.json",
  "examples/git-history/escape-string-regexp/LICENSE",
  "conformance/v1/bundle.json",
  "conformance/v1/schemas/expected-digests.json",
  "conformance/schema-extensions.json",
  "dist/build-info.json",
  "integrations/skill/SKILL.md",
  "benchmarks/agentic-profile/public/README.md",
  ...readdirSync(path.join(ROOT, "schemas"))
    .filter((name) => name.endsWith(".json"))
    .map((name) => `schemas/${name}`),
];
const forbidden = [
  /^benchmarks\/agentic-profile\/private\//,
  /^benchmarks\/.*RESULT-.*\.md$/,
  /(^|\/)node_modules\//,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.env(\/|\.|$)/,
  /(^|\/)(graphify-out|\.omx|\.testforge)(\/|$)/,
  /\.(case|provenance)\.json$/,
];
interface CommandResult {
  command: string;
  args: string[];
  cwd: string;
  status: number | null;
  signal: string | null;
  error: string | null;
  stdout: string;
  stderr: string;
}
const commands: CommandResult[] = [];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
function jsonFile(target: string, value: unknown): void {
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}
function run(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  command = process.execPath,
): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const record = {
    command,
    args,
    cwd,
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  commands.push(record);
  return record;
}
function successful(result: CommandResult): void {
  assert.equal(result.error, null, `Process error: ${result.error}`);
  assert.equal(result.signal, null, `Process signal: ${result.signal}`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function parse(result: CommandResult) {
  successful(result);
  return JSON.parse(result.stdout.trim());
}
function npmEntry(): string {
  const directory = path.dirname(process.execPath);
  const candidates = [
    path.join(directory, "node_modules/npm/bin/npm-cli.js"),
    path.join(directory, "../lib/node_modules/npm/bin/npm-cli.js"),
    path.join(directory, "../share/nodejs/npm/bin/npm-cli.js"),
  ];
  const entry = candidates.find(existsSync);
  assert.ok(entry, "NPM_CLI_NOT_FOUND: install Node with npm beside its executable");
  return realpathSync(entry);
}

function main(): void {
  for (const directory of [path.join(ROOT, ".testforge"), artifactRoot]) {
    if (existsSync(directory))
      assert.ok(inside(ROOT, realpathSync(directory)), "ARTIFACT_PATH_ESCAPE");
    else mkdirSync(directory);
  }
  mkdirSync(artifacts);
  assert.ok(inside(ROOT, realpathSync(artifacts)), "ARTIFACT_PATH_ESCAPE");
  const temporaryRoot = realpathSync(os.tmpdir());
  const workspace = mkdtempSync(path.join(temporaryRoot, "assertledger-package-"));
  const marker = path.join(workspace, ".owner");
  writeFileSync(marker, runId);
  const consumer = path.join(workspace, "consumer with spaces");
  const packDirectory = path.join(workspace, "pack");
  mkdirSync(consumer);
  mkdirSync(packDirectory);
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "COMSPEC",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Consumer installs use no operator npm configuration or lifecycle hooks.
  const userConfig = path.join(workspace, "user.npmrc");
  const globalConfig = path.join(workspace, "global.npmrc");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  Object.assign(env, {
    HOME: workspace,
    USERPROFILE: workspace,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    npm_config_cache: path.join(workspace, "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  });
  const npm = npmEntry();
  const runNpm = (args: string[], cwd = consumer) => run([npm, ...args], cwd, env);
  const installed = path.join(consumer, "node_modules", "assertledger");
  const runBin = (alias: string, args: string[]) => {
    const metadata = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
    assert.equal(metadata.bin[alias], "dist/cli.js");
    const shim = path.join(
      consumer,
      "node_modules",
      ".bin",
      alias + (process.platform === "win32" ? ".cmd" : ""),
    );
    assert.ok(existsSync(shim), `BIN_SHIM_MISSING: ${alias}`);
    return runNpm(["exec", "--offline", "--yes=false", "--", alias, ...args]);
  };
  try {
    const metadata = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const npmVersion = runNpm(["--version"]);
    successful(npmVersion);
    const packed = parse(
      runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory], ROOT),
    );
    assert.equal(packed.length, 1);
    const entry = packed[0] as {
      name: string;
      version: string;
      filename: string;
      files: { path: string }[];
    };
    assert.equal(entry.name, metadata.name);
    assert.equal(entry.version, metadata.version);
    assert.equal(path.basename(entry.filename), entry.filename, "INVALID_PACK_FILENAME");
    const packedFiles = new Set(entry.files.map((file) => file.path));
    for (const filename of required)
      assert.ok(packedFiles.has(filename), `PACKAGE_FILE_MISSING: ${filename}`);
    for (const filename of packedFiles)
      assert.ok(
        !forbidden.some((pattern) => pattern.test(filename)),
        `PACKAGE_FILE_FORBIDDEN: ${filename}`,
      );
    const tarball = path.join(packDirectory, entry.filename);
    const tarballDigest = hash(readFileSync(tarball));
    copyFileSync(tarball, path.join(artifacts, entry.filename));
    jsonFile(path.join(artifacts, "pack.json"), packed);
    jsonFile(path.join(consumer, "package.json"), {
      name: "assertledger-smoke-consumer",
      private: true,
      version: "0.0.0",
      type: "module",
    });
    successful(
      runNpm([
        "install",
        tarball,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ]),
    );
    for (const filename of required) {
      const resolved = realpathSync(path.join(installed, filename));
      assert.ok(inside(realpathSync(installed), resolved), `INSTALLED_FILE_ESCAPE: ${filename}`);
      assert.ok(!inside(ROOT, resolved), "INSTALLED_FILE_RESOLVES_TO_CHECKOUT");
      assert.equal(
        hash(readFileSync(resolved)),
        hash(readFileSync(path.join(ROOT, filename))),
        `INSTALLED_CONTENT_MISMATCH: ${filename}`,
      );
    }
    const importGuard = path.join(consumer, "installed-import-guard.mjs");
    writeFileSync(
      importGuard,
      [
        'import { registerHooks } from "node:module";',
        'import { realpathSync } from "node:fs";',
        'import path from "node:path";',
        'import { fileURLToPath } from "node:url";',
        `const consumer = realpathSync(${JSON.stringify(consumer)});`,
        'const inside = (value) => { const rel = path.relative(consumer, value); return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)); };',
        "registerHooks({ resolve(specifier, context, nextResolve) {",
        "  const result = nextResolve(specifier, context);",
        '  if (context.parentURL?.startsWith("file:") && result.url.startsWith("file:") && inside(fileURLToPath(context.parentURL)) && !inside(realpathSync(fileURLToPath(result.url)))) {',
        '    throw new Error("PACKAGE_IMPORT_ESCAPES_CONSUMER: " + specifier);',
        "  }",
        "  return result;",
        "} });",
        "",
      ].join("\n"),
    );
    // Only the verification processes receive this guard; npm install ran without it.
    env.NODE_OPTIONS = `--import=${pathToFileURL(importGuard).href}`;
    const schema = parse(runBin("assertledger", ["schema", "replay-result"]));
    assert.equal(schema.$id, "https://testforge.dev/schemas/replay-result.v1.json");
    assert.deepEqual(parse(runBin("testforge", ["schema", "replay-result"])), schema);

    const fixture = path.join(consumer, "fixture");
    mkdirSync(path.join(fixture, "tests"), { recursive: true });
    jsonFile(path.join(fixture, "package.json"), {
      name: "fixture",
      type: "module",
      packageManager: "npm@10.0.0",
      scripts: { test: "node --test" },
    });
    writeFileSync(
      path.join(fixture, "tests/base.test.js"),
      'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("ready", () => assert.equal(1, 1));\n',
    );
    const init = parse(runBin("assertledger", ["init", fixture, "--dry-run", "--json"]));
    assert.equal(init.status, "WOULD_CREATE");
    const audit = parse(runBin("assertledger", ["audit", fixture, "--no-git", "--json"]));
    assert.equal(audit.schemaVersion, "1.0.0");
    assert.equal(audit.fileCount, 2);
    assert.ok(Array.isArray(audit.files));
    assert.match(audit.repositoryDigest, /^sha256:[a-f0-9]{64}$/);
    assert.ok(!existsSync(path.join(fixture, "assertledger.config.json")));

    const sdkScript = path.join(consumer, "consumer.mjs");
    const sdkSource = [
      'import assert from "node:assert/strict";',
      'import { realpathSync } from "node:fs";',
      'import path from "node:path";',
      'import { fileURLToPath } from "node:url";',
      'import { AssertLedger, TestForge } from "assertledger";',
      'import { canonicalize } from "assertledger/core";',
      `const root = realpathSync(${JSON.stringify(installed)});`,
      'for (const specifier of ["assertledger", "assertledger/core"]) {',
      "  const relative = path.relative(root, realpathSync(fileURLToPath(import.meta.resolve(specifier))));",
      '  assert.ok(relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));',
      "}",
      "assert.ok(TestForge.prototype instanceof AssertLedger);",
      'assert.equal(canonicalize({ b: 2, a: 1 }), \'{"a":1,"b":2}\');',
      "const sdk = new AssertLedger(); const legacy = new TestForge();",
      'assert.deepEqual(sdk.schema("replay-result"), legacy.schema("replay-result"));',
      "for (const instance of [sdk, legacy]) {",
      "  assert.equal((await instance.init(" +
        JSON.stringify(fixture) +
        ', { dryRun: true })).status, "WOULD_CREATE");',
      `  const audit = await instance.audit(${JSON.stringify(fixture)}, { noGit: true });`,
      '  assert.equal(audit.schemaVersion, "1.0.0"); assert.equal(audit.fileCount, 2);',
      "}",
      'console.log(JSON.stringify({ status: "PASS", exports: ["assertledger", "assertledger/core"], aliases: ["AssertLedger", "TestForge"] }));',
      "",
    ].join("\n");
    writeFileSync(sdkScript, sdkSource);
    const sdk = parse(run([sdkScript], consumer, env));
    assert.equal(sdk.status, "PASS");
    const typesScript = path.join(consumer, "consumer.ts");
    writeFileSync(
      typesScript,
      [
        'import { AssertLedger, TestForge, type AgenticProfileReplayResult, type AgenticProfileReport, type EvidenceManifestContract, type ReplayResult } from "assertledger";',
        'import { canonicalize, replayEvidenceManifest } from "assertledger/core";',
        "const sdk: AssertLedger = new TestForge();",
        "const manifest: EvidenceManifestContract = await sdk.verify({});",
        "const replay: ReplayResult = sdk.replay(manifest);",
        "const profile: AgenticProfileReport = sdk.profile({ manifest });",
        "const profileReplay: AgenticProfileReplayResult = sdk.replayProfile(profile);",
        "const valid: boolean = replayEvidenceManifest(manifest).valid && replay.valid && profileReplay.valid;",
        "const text: string = canonicalize({ valid });",
        "void text;",
        "",
      ].join("\n"),
    );
    const compile = () =>
      run(
        [
          path.join(ROOT, "node_modules/typescript/bin/tsc"),
          "--noEmit",
          "--strict",
          "--module",
          "NodeNext",
          "--target",
          "ES2022",
          "--types",
          "node",
          "--typeRoots",
          path.join(ROOT, "node_modules/@types"),
          typesScript,
        ],
        consumer,
        env,
      );
    successful(compile());
    const request = JSON.parse(
      readFileSync(path.join(installed, "examples/node-test/request.json"), "utf8"),
    );
    request.repository.root = path.join(installed, "examples/node-test/repository");
    const requestPath = path.join(consumer, "request.json");
    jsonFile(requestPath, request);
    const manifest = parse(
      runBin("assertledger", ["verify", requestPath, "--allow-unsafe-execution", "--json"]),
    );
    assert.equal(manifest.decision.status, "VERIFIED");
    assert.deepEqual(manifest.decision.selectedCandidateIds, ["strong"]);
    assert.ok(
      manifest.candidates.some(
        (candidate: { id: string; status: string }) =>
          candidate.id === "weak" && candidate.status === "WEAK_ORACLE",
      ),
    );
    const manifestPath = path.join(consumer, "manifest.json");
    jsonFile(manifestPath, manifest);
    jsonFile(path.join(artifacts, "manifest.json"), manifest);
    const replay = parse(runBin("assertledger", ["replay", manifestPath]));
    assert.deepEqual(replay, {
      valid: true,
      schemaValid: true,
      artifactDigestValid: true,
      decisionDigestValid: true,
      decisionSemanticsValid: true,
    });
    jsonFile(path.join(artifacts, "replay.json"), replay);

    // Agentic Test Profile v1 derived by the installed CLI and SDK from the manifest verified above.
    const profileRequest = {
      schemaVersion: "1.0.0",
      manifest,
      policy: {
        profileVersion: "1.0.0",
        profileId: "package-smoke/default",
        mode: "HARDENING",
        minimumTimingSamples: 1,
        lanes: [{ id: "gate", maximumReferenceP95Ms: 86_400_000 }],
      },
    };
    const profileRequestPath = path.join(consumer, "profile-request.json");
    jsonFile(profileRequestPath, profileRequest);
    const profile = parse(runBin("assertledger", ["profile", profileRequestPath, "--json"]));
    assert.equal(profile.status, "QUALIFIED");
    assert.deepEqual(profile.qualifiedCandidateIds, ["strong"]);
    assert.equal(profile.sourceArtifactDigest, manifest.artifactDigest);
    const profilePath = path.join(consumer, "profile-report.json");
    jsonFile(profilePath, profile);
    const profileReplay = parse(runBin("assertledger", ["profile-replay", profilePath, "--json"]));
    assert.equal(profileReplay.valid, true);
    const forgedProfilePath = path.join(consumer, "profile-report-forged.json");
    jsonFile(forgedProfilePath, { ...profile, qualifiedCandidateIds: [] });
    const forgedProfileReplay = runBin("assertledger", [
      "profile-replay",
      forgedProfilePath,
      "--json",
    ]);
    assert.equal(forgedProfileReplay.status, 4, forgedProfileReplay.stderr);
    assert.equal(JSON.parse(forgedProfileReplay.stdout).valid, false);
    const sdkProfileScript = path.join(consumer, "consumer-profile.mjs");
    writeFileSync(
      sdkProfileScript,
      [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        'import { AssertLedger } from "assertledger";',
        `const request = JSON.parse(readFileSync(${JSON.stringify(profileRequestPath)}, "utf8"));`,
        "const sdk = new AssertLedger();",
        "const report = sdk.profile(request);",
        `assert.equal(report.reportDigest, ${JSON.stringify(profile.reportDigest)});`,
        "assert.equal(sdk.replayProfile(report).valid, true);",
        "console.log(JSON.stringify({ status: report.status, reportDigest: report.reportDigest }));",
        "",
      ].join("\n"),
    );
    assert.deepEqual(parse(run([sdkProfileScript], consumer, env)), {
      status: "QUALIFIED",
      reportDigest: profile.reportDigest,
    });
    // The copyable example keeps its three-sample policy; two reference attempts stay insufficient.
    const example = run(
      [
        path.join(installed, "examples/agentic-profile/profile-manifest.mjs"),
        manifestPath,
        "package-smoke/example",
      ],
      consumer,
      env,
    );
    assert.equal(example.error, null);
    assert.equal(example.signal, null);
    assert.equal(
      example.status,
      3,
      `PROFILE_EXAMPLE_EXIT_CODE_MISMATCH: ${example.status} ${example.stderr}`,
    );
    const exampleReport = JSON.parse(example.stdout.trim());
    assert.equal(exampleReport.status, "INSUFFICIENT_TIMING_EVIDENCE");
    assert.equal(exampleReport.sourceArtifactDigest, manifest.artifactDigest);
    const exampleReportPath = path.join(consumer, "profile-example-report.json");
    jsonFile(exampleReportPath, exampleReport);
    assert.equal(
      parse(runBin("assertledger", ["profile-replay", exampleReportPath, "--json"])).valid,
      true,
    );
    jsonFile(path.join(artifacts, "profile-report.json"), profile);
    jsonFile(path.join(artifacts, "profile-replay.json"), profileReplay);
    jsonFile(path.join(artifacts, "profile-example-report.json"), exampleReport);

    // Evidence export: provider identity, deterministic export and replay, independent consumer.
    const provider = parse(runBin("assertledger", ["provider", "--json"]));
    assert.equal(provider.provider.name, "assertledger");
    assert.equal(
      provider.provider.version,
      JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8")).version,
    );
    assert.deepEqual(
      provider.provider.sourceRevision,
      JSON.parse(readFileSync(path.join(installed, "dist/build-info.json"), "utf8")).sourceRevision,
    );
    const sourceHead = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
    });
    const sourceRevisionMismatch = `PROVIDER_SOURCE_REVISION_MISMATCH: ${JSON.stringify(provider.provider.sourceRevision)}`;
    if (sourceHead.status === 0) {
      assert.equal(provider.provider.sourceRevision.status, "RECORDED", sourceRevisionMismatch);
      assert.equal(
        provider.provider.sourceRevision.commit,
        sourceHead.stdout.trim(),
        sourceRevisionMismatch,
      );
    } else {
      assert.deepEqual(
        provider.provider.sourceRevision,
        { status: "UNKNOWN" },
        sourceRevisionMismatch,
      );
    }
    const exportRequest = {
      schemaVersion: "1.0.0",
      manifest,
      consumerRequest: {
        reference: "package-smoke",
        profileId: null,
        obligations: [
          { id: "detect", control: "REGRESSION_DETECTION" },
          { id: "sandbox", control: "SANDBOXED_EXECUTION" },
        ],
      },
    };
    const exportRequestPath = path.join(consumer, "evidence-export-request.json");
    jsonFile(exportRequestPath, exportRequest);
    const evidenceExport = parse(runBin("assertledger", ["export", exportRequestPath, "--json"]));
    assert.equal(evidenceExport.result.detection, "OBSERVED");
    assert.equal(evidenceExport.sourceArtifactDigest, manifest.artifactDigest);
    assert.equal(evidenceExport.controls.requested.status, "PARTIAL");
    const exportPath = path.join(consumer, "evidence-export.json");
    jsonFile(exportPath, evidenceExport);
    const exportReplay = parse(runBin("assertledger", ["export-replay", exportPath, "--json"]));
    assert.equal(exportReplay.valid, true);
    const sdkExportScript = path.join(consumer, "consumer-export.mjs");
    writeFileSync(
      sdkExportScript,
      [
        'import { readFileSync } from "node:fs";',
        'import { AssertLedger } from "assertledger";',
        `const request = JSON.parse(readFileSync(${JSON.stringify(exportRequestPath)}, "utf8"));`,
        "const exported = new AssertLedger().exportEvidence(request);",
        "console.log(JSON.stringify({ exportDigest: exported.exportDigest }));",
        "",
      ].join("\n"),
    );
    assert.deepEqual(parse(run([sdkExportScript], consumer, env)), {
      exportDigest: evidenceExport.exportDigest,
    });
    const consumerExample = path.join(installed, "examples/evidence-export/consumer.mjs");
    const consumerDecision = parse(run([consumerExample, exportPath], consumer, env));
    assert.equal(
      consumerDecision.decision,
      "DEGRADE",
      `EVIDENCE_CONSUMER_DECISION_MISMATCH: ${consumerDecision.decision}`,
    );
    assert.ok(consumerDecision.reasons.includes("EVIDENCE_UNAUTHENTICATED"));
    const forgedExportPath = path.join(consumer, "evidence-export-forged.json");
    jsonFile(forgedExportPath, {
      ...evidenceExport,
      result: { ...evidenceExport.result, detection: "NOT_OBSERVED" },
    });
    const forgedExportReplay = runBin("assertledger", [
      "export-replay",
      forgedExportPath,
      "--json",
    ]);
    assert.equal(
      forgedExportReplay.status,
      4,
      `EVIDENCE_EXPORT_FORGED_REPLAY_EXIT_CODE_MISMATCH: ${forgedExportReplay.status} ${forgedExportReplay.stderr}`,
    );
    assert.equal(JSON.parse(forgedExportReplay.stdout).valid, false);
    const forgedDecision = parse(run([consumerExample, forgedExportPath], consumer, env));
    assert.equal(
      forgedDecision.decision,
      "REJECT",
      `EVIDENCE_CONSUMER_FORGED_EXPORT_NOT_REJECTED: ${forgedDecision.decision}`,
    );
    assert.deepEqual(parse(runBin("assertledger", ["replay", manifestPath])), replay);
    jsonFile(path.join(artifacts, "provider-manifest.json"), provider);
    jsonFile(path.join(artifacts, "evidence-export.json"), evidenceExport);
    jsonFile(path.join(artifacts, "evidence-export-replay.json"), exportReplay);

    // Main product journey, using installed code and byte-exact snapshots of a real correction.
    const historical = parse(
      run(
        [
          path.join(installed, "examples/git-history/create-demo.mjs"),
          path.join(consumer, "historical regression"),
        ],
        consumer,
        env,
      ),
    );
    const historyRoot = historical.repository as string;
    jsonFile(path.join(artifacts, "historical-provenance.json"), historical);
    const sourceFiles = readdirSync(historyRoot).filter((name) => name !== ".git");
    const beforeSources = sourceFiles.map((name) => [
      name,
      hash(readFileSync(path.join(historyRoot, name))),
    ]);
    const beforeIndex = hash(readFileSync(path.join(historyRoot, ".git/index")));
    const beforeHead = run(["-C", historyRoot, "rev-parse", "HEAD"], consumer, env, "git");
    successful(beforeHead);
    for (const [candidate, expected] of [
      ["strong", "VERIFIED"],
      ["weak", "REJECTED"],
      ["crash", "REJECTED"],
    ] as const) {
      const evidenceDirectory = `evidence-${candidate}`;
      const observation = runBin("assertledger", [
        "check",
        historyRoot,
        "--before",
        historical.before,
        "--after",
        historical.after,
        "--neutral",
        historical.neutral,
        "--neutral-reason",
        historical.neutralReason,
        "--test",
        `${candidate}.test.mjs`,
        "--base-test",
        "base.test.mjs",
        "--out",
        evidenceDirectory,
        "--allow-unsafe-execution",
        "--json",
      ]);
      assert.equal(observation.error, null);
      assert.equal(observation.signal, null);
      assert.equal(observation.status, expected === "VERIFIED" ? 0 : 2, observation.stderr);
      const evidence = JSON.parse(observation.stdout);
      assert.equal(evidence.decision.status, expected);
      const target = evidence.observations.filter(
        (item: { worldId: string; candidateId: string }) =>
          item.worldId === "known-bug" && item.candidateId === "git-regression-candidate",
      );
      assert.equal(target.length, 2);
      assert.ok(
        target.every(
          (item: { outcome: string; attributed: boolean }) =>
            item.outcome ===
              (candidate === "strong"
                ? "ASSERTION_FAILURE"
                : candidate === "weak"
                  ? "PASS"
                  : "PROCESS_CRASH") && item.attributed === (candidate !== "crash"),
        ),
      );
      const saved = path.join(historyRoot, evidenceDirectory);
      const replayed = parse(runBin("assertledger", ["replay", path.join(saved, "manifest.json")]));
      assert.equal(replayed.valid, true);
      for (const file of ["manifest.json", "executed-request.json", "summary.md"]) {
        copyFileSync(
          path.join(saved, file),
          path.join(artifacts, `historical-${candidate}-${file}`),
        );
      }
      jsonFile(path.join(artifacts, `historical-${candidate}-replay.json`), replayed);
    }
    assert.deepEqual(
      sourceFiles.map((name) => [name, hash(readFileSync(path.join(historyRoot, name)))]),
      beforeSources,
    );
    assert.equal(hash(readFileSync(path.join(historyRoot, ".git/index"))), beforeIndex);
    const afterHead = run(["-C", historyRoot, "rev-parse", "HEAD"], consumer, env, "git");
    successful(afterHead);
    assert.equal(afterHead.stdout, beforeHead.stdout);
    jsonFile(path.join(artifacts, "historical-checkout-preserved.json"), {
      head: beforeHead.stdout.trim(),
      indexSha256: beforeIndex,
      files: beforeSources,
      preserved: true,
    });

    const witness = (
      name: string,
      target: string,
      breakFile: () => void,
      execute: () => CommandResult,
      checkFailure: (result: CommandResult) => void,
      validate: (result: CommandResult) => void,
    ) => {
      assert.ok(inside(realpathSync(installed), realpathSync(target)), "WITNESS_TARGET_ESCAPE");
      const original = readFileSync(target);
      let red: CommandResult;
      try {
        breakFile();
        red = execute();
      } finally {
        writeFileSync(target, original);
      }
      const green = execute();
      const restored = hash(readFileSync(target));
      jsonFile(path.join(artifacts, `${name}.json`), {
        target: path.relative(installed, target),
        beforeSha256: hash(original),
        restoredSha256: restored,
        red,
        green,
      });
      assert.equal(restored, hash(original));
      assert.equal(red.error, null);
      assert.equal(red.signal, null);
      assert.ok(Number.isInteger(red.status) && red.status !== 0, "WITNESS_RED_EXPECTED_FAILURE");
      checkFailure(red);
      validate(green);
    };
    const runtime = path.join(installed, "dist/core/index.js");
    witness(
      "missing-runtime",
      runtime,
      () => rmSync(runtime),
      () => runBin("assertledger", ["schema", "replay-result"]),
      (result) => {
        assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
        assert.ok(result.stderr.includes(runtime), "WITNESS_WRONG_FAILURE");
      },
      (result) => assert.deepEqual(parse(result), schema),
    );
    const packageFile = path.join(installed, "package.json");
    witness(
      "broken-export",
      packageFile,
      () => {
        const broken = JSON.parse(readFileSync(packageFile, "utf8"));
        broken.exports["./core"].import = "./dist/core/absent-package-smoke.js";
        jsonFile(packageFile, broken);
      },
      () => run([sdkScript], consumer, env),
      (result) => {
        assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/);
        assert.ok(result.stderr.includes("absent-package-smoke.js"), "WITNESS_WRONG_FAILURE");
      },
      (result) => assert.deepEqual(parse(result), sdk),
    );

    witness(
      "broken-types-export",
      packageFile,
      () => {
        const broken = JSON.parse(readFileSync(packageFile, "utf8"));
        broken.exports["."].types = "./dist/contracts/index.d.ts";
        jsonFile(packageFile, broken);
      },
      compile,
      (result) => {
        assert.match(result.stdout, /TS2305/);
        assert.match(result.stdout, /AssertLedger/);
      },
      successful,
    );

    const report = {
      status: "PASS",
      tool: { node: process.version, npm: npmVersion.stdout.trim(), platform: process.platform },
      package: { name: entry.name, version: entry.version },
      tarball: { path: path.join(artifacts, entry.filename), sha256: tarballDigest },
      artifacts,
      decision: manifest.decision,
      replay,
      sdk,
      typescript: JSON.parse(
        readFileSync(path.join(ROOT, "node_modules/typescript/package.json"), "utf8"),
      ).version,
      initStatus: init.status,
      profile: {
        status: profile.status,
        reportDigest: profile.reportDigest,
        replayValid: profileReplay.valid,
      },
      profileExample: { exitCode: example.status, status: exampleReport.status },
      evidenceExport: {
        sourceRevision: provider.provider.sourceRevision.status,
        detection: evidenceExport.result.detection,
        exportDigest: evidenceExport.exportDigest,
        replayValid: exportReplay.valid,
        consumerDecision: consumerDecision.decision,
        forgedConsumerDecision: forgedDecision.decision,
      },
    };
    jsonFile(path.join(artifacts, "report.json"), report);
    console.log(JSON.stringify(report));
  } finally {
    try {
      jsonFile(path.join(artifacts, "commands.json"), commands);
    } finally {
      assert.equal(path.dirname(realpathSync(workspace)), temporaryRoot, "CLEANUP_PARENT_MISMATCH");
      assert.ok(
        path.basename(workspace).startsWith("assertledger-package-"),
        "CLEANUP_NAME_MISMATCH",
      );
      assert.equal(readFileSync(marker, "utf8"), runId, "CLEANUP_OWNER_MISMATCH");
      assert.ok(!inside(workspace, ROOT) && workspace !== ROOT, "CLEANUP_SOURCE_OVERLAP");
      rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
try {
  main();
} catch (error) {
  console.error(
    JSON.stringify({
      status: "FAIL",
      reason: error instanceof Error ? error.message : String(error),
      artifacts,
    }),
  );
  process.exitCode = 1;
}
