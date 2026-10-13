import assert from "node:assert/strict";
import { it } from "node:test";
import { designatedBunConfig } from "../integrations/bun/driver.mjs";
import { bunTestPreloads, computeTestClosure } from "../src/engine/test-closure.js";

it("keeps the JSX runtime selected by top-level bunfig settings", async () => {
  const sources: Record<string, string> = {
    "test.tsx": "export const view = <div />;",
    "bunfig.toml": 'jsxImportSource = "preact"\n[test]\nroot = "."\n',
    "node_modules/preact/package.json": '{"name":"preact"}',
    "node_modules/preact/jsx-runtime.js": "export const jsx = () => {};",
  };
  const closure = await computeTestClosure({
    files: Object.keys(sources),
    links: [],
    roots: ["test.tsx"],
    read: async (file) => [sources[file] ?? ""],
  });
  assert.ok(closure.files.includes("node_modules/preact/jsx-runtime.js"));
});

it("uses paths and JSX sources inherited from installed package configurations", async () => {
  const sources: Record<string, string> = {
    "test.tsx": 'import "@src/foo"; export const view = <div />;',
    "tsconfig.json": '{"extends":"@org/config/base.json"}',
    "node_modules/@org/config/package.json": '{"name":"@org/config"}',
    "node_modules/@org/config/base.json":
      '{"compilerOptions":{"baseUrl":"../../..","paths":{"@src/*":["src/*"]},"jsxImportSource":"preact"}}',
    "src/foo.ts": "export {};",
    "node_modules/preact/package.json": '{"name":"preact"}',
    "node_modules/preact/jsx-runtime.js": "export const jsx = () => {};",
  };
  const closure = await computeTestClosure({
    files: Object.keys(sources),
    links: [],
    roots: ["test.tsx"],
    read: async (file) => [sources[file] ?? ""],
  });
  assert.ok(closure.files.includes("src/foo.ts"));
  assert.ok(closure.files.includes("node_modules/preact/jsx-runtime.js"));
});

it("keeps a multiline test preload and ignores top-level preload", async () => {
  assert.deepEqual(
    bunTestPreloads('preload = ["./top.ts"]\n[test]\npreload = [\n "./setup.ts",\n]\n'),
    ["./setup.ts"],
  );
  const sources: Record<string, string> = {
    "test.ts": "export {};",
    "bunfig.toml": '[test]\npreload = [\n "./setup.ts",\n]\n',
    "setup.ts": 'import "./dependency";',
    "dependency.ts": "export {};",
  };
  const closure = await computeTestClosure({
    files: Object.keys(sources),
    links: [],
    roots: ["test.ts"],
    read: async (file) => [sources[file] ?? ""],
  });
  assert.ok(closure.files.includes("dependency.ts"));
  assert.deepEqual(closure.unbounded, []);
});

it("keeps JSX runtimes from compiler configs and per-file directives", async () => {
  for (const configured of [true, false]) {
    const sources: Record<string, string> = {
      "test.tsx": `${configured ? "" : "/** @jsxImportSource preact */"}\nexport const view = <div />;`,
      "tsconfig.json": configured ? '{"compilerOptions":{"jsxImportSource":"preact"}}' : "{}",
      "node_modules/preact/package.json": '{"name":"preact"}',
      "node_modules/preact/jsx-runtime.js": "export const jsx = () => {};",
    };
    const closure = await computeTestClosure({
      files: Object.keys(sources),
      links: [],
      roots: ["test.tsx"],
      read: async (file) => [sources[file] ?? ""],
    });
    assert.ok(
      closure.files.includes("node_modules/preact/jsx-runtime.js"),
      `configured=${configured}`,
    );
  }
});

it("follows paths inherited from a generically named compiler configuration", async () => {
  const sources: Record<string, string> = {
    "test.ts": 'import "@src/foo";',
    "tsconfig.json": '{"extends":"./config/base.json"}',
    "config/base.json": '{"compilerOptions":{"baseUrl":"..","paths":{"@src/*":["src/*"]}}}',
    "src/foo.ts": "export {};",
  };
  const closure = await computeTestClosure({
    files: Object.keys(sources),
    links: [],
    roots: ["test.ts"],
    read: async (file) => [sources[file] ?? ""],
  });
  assert.ok(closure.files.includes("src/foo.ts"));
});

it("keeps extended compiler configs and implicit JSX dependencies without links", async () => {
  const sources: Record<string, string> = {
    "test.tsx": "export const view = <div />;",
    "tsconfig.json": '{"extends":"./config/base.json"}',
    "config/base.json": '{"compilerOptions":{"jsx":"react-jsx"}}',
    "node_modules/react/package.json": '{"name":"react"}',
    "node_modules/react/jsx-runtime.js": "export const jsx = () => {};",
  };
  const closure = await computeTestClosure({
    files: Object.keys(sources),
    links: [],
    roots: ["test.tsx"],
    read: async (file) => [sources[file] ?? ""],
  });
  assert.ok(closure.files.includes("config/base.json"));
  assert.ok(closure.files.includes("node_modules/react/jsx-runtime.js"));
});

it("keeps package import aliases in the importing package scope", async () => {
  const sources: Record<string, string> = {
    "pkg/test.ts": 'import "#src/foo";',
    "pkg/package.json": '{"imports":{"#src/*":{"bun":"./src/*.ts","default":"./fallback/*.ts"}}}',
    "pkg/src/foo.ts": 'import "./dependency";',
    "pkg/src/dependency.ts": "export const value = 1;",
    "pkg/fallback/foo.ts": "export const value = 2;",
  };
  const closure = await computeTestClosure({
    files: Object.keys(sources),
    links: [],
    roots: ["pkg/test.ts"],
    read: async (file) => [sources[file] ?? ""],
  });
  assert.ok(closure.files.includes("pkg/src/foo.ts"));
  assert.ok(closure.files.includes("pkg/src/dependency.ts"));
  assert.ok(closure.files.includes("pkg/fallback/foo.ts"));
});

it("refuses unresolved package imports instead of silently pruning them", async () => {
  await assert.rejects(
    computeTestClosure({
      files: ["test.ts"],
      links: [],
      roots: ["test.ts"],
      read: async () => ['import "#missing";'],
    }),
    /TEST_CLOSURE_PACKAGE_IMPORT_UNSUPPORTED/u,
  );
});

it("refuses quoted components of dotted test preload keys", () => {
  for (const first of ["test", '"test"', "'test'"]) {
    for (const second of ["preload", '"preload"', "'preload'"]) {
      assert.throws(
        () => designatedBunConfig(`${first}.${second} = ["./setup.ts"]\n`, "./ours.mjs"),
        /BUNFIG_TEST_PRELOAD_UNSUPPORTED/u,
      );
    }
  }
});
