import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const fixture = fileURLToPath(new URL("../examples/orchestration/workspace/", import.meta.url));
const manifest = (relative: string) =>
  readFile(
    new URL(`../examples/orchestration/workspace/${relative}`, import.meta.url),
    "utf8",
  ).then((text) => JSON.parse(text));

test("public fixture package manager matches its qualified tool pin", async () => {
  const root = await manifest("package.json");
  assert.equal(root.packageManager, "pnpm@12.9.1", "FIXTURE_PACKAGE_MANAGER_PIN_MISMATCH");
});

test("public fixture root manifest has no executable routing keys", async () => {
  const root = await manifest("package.json");
  assert.equal(Object.hasOwn(root, "scripts"), false, "FIXTURE_ROOT_ROUTE_ADDED");
  assert.equal(Object.hasOwn(root, "workspaces"), false, "FIXTURE_ROOT_ROUTE_ADDED");
});

test("public fixture lock binds the declared manager and workspace dependency", async () => {
  const [root, app, leaf] = await Promise.all([
    manifest("package.json"),
    manifest("packages/app/package.json"),
    manifest("packages/leaf/package.json"),
  ]);
  const result = spawnSync(
    "bun",
    ["-e", 'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file("pnpm-lock.yaml").text())))'],
    { cwd: fixture, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, "FIXTURE_LOCK_COLLECTION_FAILED");
  const documents = JSON.parse(result.stdout);
  assert.equal(documents.length, 2, "FIXTURE_LOCK_DOCUMENTS_MISSING");
  const manager = documents[0].importers["."].packageManagerDependencies.pnpm;
  assert.equal(`pnpm@${manager.version}`, root.packageManager, "FIXTURE_LOCK_PIN_MISMATCH");
  assert.equal(manager.specifier, manager.version, "FIXTURE_LOCK_PIN_MISMATCH");
  const dependency = documents[1].importers["packages/app"].dependencies[leaf.name];
  assert.equal(dependency.specifier, app.dependencies[leaf.name], "FIXTURE_LOCK_LINK_MISMATCH");
  assert.equal(dependency.version, "link:../leaf", "FIXTURE_LOCK_LINK_MISMATCH");
});
