// biome-ignore-all lint/suspicious/noTemplateCurlyInString: These are literal JavaScript source fixtures.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";
import { SyntaxKind } from "typescript/unstable/ast";
import { parseRepositoryAuditV2 } from "../src/contracts/index.js";
import { explainReasonCodes } from "../src/diagnostics.js";
import { scanJavaScriptTokens } from "../src/engine/javascript-tokens.js";
import { scanModuleSpecifiers } from "../src/engine/test-closure.js";

const execFileAsync = promisify(execFile);

it("terminates with consuming monotone tokens on a fixed adversarial corpus", () => {
  const expressions = [
    "",
    "#",
    "###",
    "const a = `${1} #`;",
    "`${x} ### ${y}`",
    "`${{ value: x }.value} # ${y}`",
    "`${`${x} #`} ### ${y}`",
    "`${x /* } # */} #`",
    "`${x // } #\n} #`",
    "`${/#/.test(x)} #`",
    "`${/}/.test(x)} #`",
    "`${/[{}#]/.test(x)} #`",
    "`${x / y} #`",
    "`${x / y / z} #`",
    "`${x ? `${y} ###` : `${z} #`} #`",
    "const escaped = `\\` \\${literal} \\\\ #`;",
    "`",
    "`${",
    "`${x",
    "`${x} #",
    "/* unterminated # ${",
    "'unterminated #",
    "// # ${\n",
    "const pattern = /#/g;",
    "const pattern = /[{}#]/;",
    "class C { #private = 1; }",
    "\0\uFEFF#",
    "😀#",
    "\r\n#\r\n",
  ];
  const contexts = [
    ["", ""],
    ["/* } # */\n", "\n// ${ #"],
    ["const before = /#/;\n", "\nconst after = /[{}#]/;"],
    ["`outer ${", "} # tail`"],
  ];
  for (const expression of expressions) {
    for (const [prefix, suffix] of contexts) {
      const source = `${prefix}${expression}${suffix}`;
      let end = 0;
      let count = 0;
      for (const token of scanJavaScriptTokens(source)) {
        count += 1;
        assert(count <= source.length + 1, `token bound: ${JSON.stringify(source)}`);
        assert(token.start >= end, `monotone: ${JSON.stringify(source)}`);
        assert(token.end > token.start, `consuming: ${JSON.stringify(source)}`);
        assert(token.end <= source.length);
        assert.equal(token.text, source.slice(token.start, token.end));
        end = token.end;
      }
    }
  }
});

it("keeps nested template expressions and ignores code-shaped literal text", () => {
  const tokens = [...scanJavaScriptTokens("`${{ key: `${x} #` }.key} # if ghost ? ${y}`")];
  assert.deepEqual(
    tokens.filter((token) => token.kind === SyntaxKind.Identifier).map((token) => token.value),
    ["key", "x", "key", "y"],
  );
  assert(
    !tokens.some(
      (token) => token.kind === SyntaxKind.IfKeyword || token.kind === SyntaxKind.QuestionToken,
    ),
  );
  const source =
    'import "bun:test"; const a = `${import("./inside.ts")} # require("ghost") ${`${x} #`}`;';
  const modules = scanModuleSpecifiers(source);
  assert.deepEqual([...modules.specifiers].sort(), ["./inside.ts", "bun:test"]);
  assert.equal(modules.nonLiteral, false);
});

it("explains the stable file-naming tokenization refusal", () => {
  const diagnostic = explainReasonCodes(["JAVASCRIPT_TOKENIZATION_FAILED"]).diagnostics[0];
  assert.equal(diagnostic?.known, true);
});

it("wraps an unexpected scanner failure with its file, offset and cause", () => {
  const tokens = scanJavaScriptTokens("const value = 1;", "src/problem.ts");
  const first = tokens.next();
  assert(!first.done);
  assert.equal(first.value.text, "const");
  const cause = new Error("provider failure");
  assert.throws(
    () => tokens.throw(cause),
    (error: unknown) => {
      assert(error instanceof TypeError);
      assert.equal(error.message, 'JAVASCRIPT_TOKENIZATION_FAILED: "src/problem.ts" at 5');
      assert.equal(error.cause, cause);
      return true;
    },
  );
});

it("audit terminates on substituted template hashes and preserves syntax signals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assertledger-template-audit-"));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "tests"));
    const source =
      "export const a = `${1} #`; export const choose = (x) => x ? 1 : 0; export const x = 1; export const y = 2;";
    const test = "const b = `${x} ### ${y}`; const c = `${x} choose if ? ### ${y}`;";
    await writeFile(path.join(root, "src/value.ts"), source);
    await writeFile(path.join(root, "tests/value.test.ts"), test);
    // Observe empty lexical pushes in the isolated child, without changing token values or EOF.
    // On 2.0.0 this asserts the actual stalled stream before it can exhaust memory. A timeout
    // remains an infrastructure failure, not an assertion witness or a target kill.
    const child = `
      import assert from "node:assert/strict";
      import { runCli } from "./src/cli.ts";
      const originalPush = Array.prototype.push;
      const counts = new WeakMap();
      Array.prototype.push = function(...items) {
        if (items.length === 1 && items[0] === "") {
          const count = (counts.get(this) ?? 0) + 1;
          counts.set(this, count);
          assert(count <= ${source.length + test.length + 1}, "AUDIT_EMPTY_TOKEN_PROGRESS_STALLED");
        }
        return Reflect.apply(originalPush, this, items);
      };
      let stdout = "", stderr = "";
      try {
        const code = await runCli(["audit", process.argv[1], "--no-git", "--json"], {
          cwd: process.cwd(), readStdin: async () => "",
          writeStdout: text => { stdout += text; }, writeStderr: text => { stderr += text; }
        });
        console.log(JSON.stringify({ code, stdout, stderr }));
      } finally { Array.prototype.push = originalPush; }
    `;
    async function audit() {
      const result = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", child, root],
        { cwd: process.cwd(), timeout: 10_000, maxBuffer: 1_000_000 },
      );
      const observation = JSON.parse(result.stdout);
      assert.equal(observation.code, 0, `audit must terminate successfully: ${observation.stderr}`);
      assert.equal(observation.stderr, "");
      return parseRepositoryAuditV2(JSON.parse(observation.stdout));
    }
    const withTemplates = await audit();
    await writeFile(
      path.join(root, "src/value.ts"),
      "export const a = 1; export const choose = (x) => x ? 1 : 0; export const x = 1; export const y = 2;",
    );
    await writeFile(path.join(root, "tests/value.test.ts"), "const b = (x, y); const c = (x, y);");
    const withoutTemplates = await audit();
    const signals = (audit: typeof withTemplates) =>
      audit.files.map((file) => ({
        path: file.path,
        decisionPoints: file.decisionPoints,
        exports: file.declaredExports,
        unreferenced: file.noObservedTestReference,
        weakAssertions: file.weakAssertions,
      }));
    assert.deepEqual(signals(withTemplates), signals(withoutTemplates));
    assert.equal(
      withTemplates.files.find((file) => file.path === "src/value.ts")?.decisionPoints,
      1,
    );
    assert.deepEqual(
      withTemplates.files.find((file) => file.path === "src/value.ts")?.noObservedTestReference,
      ["a", "choose"],
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
