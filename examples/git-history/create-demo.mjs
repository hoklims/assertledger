#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The snapshots retain their upstream bytes and MIT notice. Only the harness is authored here.
const sources = path.join(path.dirname(fileURLToPath(import.meta.url)), "escape-string-regexp");
const provenance = JSON.parse(readFileSync(path.join(sources, "provenance.json"), "utf8"));
for (const source of provenance.sources) {
  const bytes = readFileSync(path.join(sources, source.file));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256);
  assert.equal(
    createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    source.gitBlob,
  );
}
assert.equal(process.argv.length, 3, "Usage: node create-demo.mjs NEW_DIRECTORY");
const requested = path.resolve(process.argv[2]);
mkdirSync(requested); // Exclusive creation: never overwrite a user's repository.
const root = realpathSync(requested);
const environment = {
  PATH: process.env.PATH ?? "",
  SystemRoot: process.env.SystemRoot ?? "",
  TEMP: process.env.TEMP ?? "",
  TMP: process.env.TMP ?? "",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(root, ".absent-global-config"),
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};
function git(args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "-c",
      "commit.gpgSign=false",
      "-c",
      `core.hooksPath=${path.join(root, ".git/no-hooks")}`,
      "-c",
      "user.name=AssertLedger Demo",
      "-c",
      "user.email=demo@example.invalid",
      ...args,
    ],
    {
      cwd: root,
      env: environment,
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_048_576,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function commit(message) {
  git(["add", "."]);
  git(["commit", "-m", message]);
  return git(["rev-parse", "HEAD"]);
}
git(["init", "--template=", "--initial-branch=main"]);
writeFileSync(
  path.join(root, "package.json"),
  '{"name":"assertledger-historical-demo","private":true}\n',
);
copyFileSync(path.join(sources, "LICENSE"), path.join(root, "LICENSE"));
copyFileSync(path.join(sources, "before.cjs.txt"), path.join(root, "subject.cjs"));
writeFileSync(
  path.join(root, "README.md"),
  "Projection of a real upstream correction; see AssertLedger example provenance.\n",
);
const prelude =
  'import assert from "node:assert/strict";\nimport test from "node:test";\nimport escape from "./subject.cjs";\n';
writeFileSync(
  path.join(root, "base.test.mjs"),
  `${prelude}test("ordinary characters", () => assert.equal(escape("hello"), "hello"));\n`,
);
writeFileSync(
  path.join(root, "strong.test.mjs"),
  `${prelude}test("Unicode hyphen regression", () => {
  assert.doesNotThrow(() => new RegExp(escape("-"), "u"));
  assert.equal(new RegExp(escape("-"), "u").test("-"), true);
});\n`,
);
writeFileSync(
  path.join(root, "weak.test.mjs"),
  `${prelude}test("weak check", () => assert.equal(typeof escape("-"), "string"));\n`,
);
writeFileSync(
  path.join(root, "crash.test.mjs"),
  `${prelude}test("generic throw is not evidence", () => {
  if (escape("-") === "\\\\-") throw new Error("generic failure");
  assert.equal(typeof escape("-"), "string");
});\n`,
);
const before = commit(
  `Upstream buggy module ${provenance.sources[0].commit}, with node:test harness`,
);
copyFileSync(path.join(sources, "fixed.cjs.txt"), path.join(root, "subject.cjs"));
const after = commit(`Upstream corrected module ${provenance.sources[1].commit}, byte-exact`);
writeFileSync(
  path.join(root, "README.md"),
  "Projection of a real upstream correction; documentation-only neutral control.\n",
);
const neutral = commit("Declared neutral: documentation-only edit to corrected tree");
console.log(
  JSON.stringify({
    repository: root,
    before,
    after,
    neutral,
    neutralReason:
      "Documentation-only change to the corrected tree; no additional behavioral robustness claim",
    test: "strong.test.mjs",
    baseTests: ["base.test.mjs"],
    out: "evidence-strong",
    provenance,
  }),
);
