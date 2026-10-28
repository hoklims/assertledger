/**
 * E7 differential replay: the TypeScript token and specifier scans against the Rust port.
 *
 * Usage, from the repository root after `cargo build --release --locked`:
 *   pnpm exec tsx rust/e7-scanner/harness/differential.ts [fixtures|tracked|codepoints]...
 *
 * Both sides serialize every record to the same line protocol (see `src/main.rs`); any record
 * whose lines differ is a mismatch. Exit 0 only when every corpus matches exactly.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SyntaxKind } from "typescript/unstable/ast";
import { scanJavaScriptTokens } from "../../../src/engine/javascript-tokens.js";
import { scanModuleSpecifiers } from "../../../src/engine/test-closure.js";

const CRATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(CRATE, "../..");
const BINARY = path.join(
  CRATE,
  "target",
  "release",
  process.platform === "win32" ? "assertledger-e7-scanner.exe" : "assertledger-e7-scanner",
);
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const BATCH = 20_000;

interface Record {
  readonly label: string;
  readonly source: string;
}

/** The first name of each SyntaxKind value, as in tests/scanner-closure-oracles.test.ts. */
const KIND_NAMES = new Map<number, string>();
for (const [name, value] of Object.entries(SyntaxKind)) {
  if (typeof value === "number" && !KIND_NAMES.has(value)) KIND_NAMES.set(value, name);
}

function hex(text: string): string {
  if (text.length === 0) return "~";
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    out += text.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return out;
}

function failurePosition(error: unknown): string {
  const match =
    error instanceof Error
      ? /^JAVASCRIPT_TOKENIZATION_FAILED: .* at (\d+)$/.exec(error.message)
      : null;
  if (match === null) throw error;
  return `X ${match[1]}`;
}

function typescriptTokens(source: string): string {
  try {
    const lines: string[] = [];
    for (const token of scanJavaScriptTokens(source)) {
      const value = token.value === undefined ? "-" : hex(token.value);
      lines.push(
        `T ${KIND_NAMES.get(token.kind)} ${token.start} ${token.end} ${hex(token.text)} ${value}`,
      );
    }
    lines.push("E");
    return lines.join("\n");
  } catch (error) {
    return failurePosition(error);
  }
}

function typescriptSpecifiers(source: string): string {
  try {
    const scan = scanModuleSpecifiers(source);
    return [
      ...[...scan.specifiers].map((specifier) => `S ${hex(specifier)}`),
      `N ${scan.nonLiteral ? 1 : 0}`,
    ].join("\n");
  } catch (error) {
    return failurePosition(error);
  }
}

function encode(records: readonly Record[]): Buffer {
  const size = records.reduce((total, record) => total + 4 + record.source.length * 2, 0);
  const buffer = Buffer.alloc(size);
  let offset = 0;
  for (const { source } of records) {
    offset = buffer.writeUInt32LE(source.length, offset);
    for (let index = 0; index < source.length; index += 1) {
      offset = buffer.writeUInt16LE(source.charCodeAt(index), offset);
    }
  }
  return buffer;
}

function rustRecords(mode: string, records: readonly Record[]): string[] {
  const result = spawnSync(BINARY, [mode], { input: encode(records), maxBuffer: 1 << 30 });
  if (result.status !== 0)
    throw new Error(`rust ${mode} exited ${result.status}: ${result.stderr}`);
  const out: string[] = [];
  let current: string[] = [];
  for (const line of result.stdout.toString("latin1").split("\n")) {
    if (line === "") continue;
    current.push(line);
    const tag = line[0];
    if (tag === "E" || tag === "X" || (mode === "specifiers" && tag === "N")) {
      out.push(current.join("\n"));
      current = [];
    }
  }
  if (current.length > 0 || out.length !== records.length) {
    throw new Error(`rust ${mode} answered ${out.length} records for ${records.length}`);
  }
  return out;
}

function fixtures(): Record[] {
  const records: Record[] = [];
  const read = (name: string) =>
    (
      JSON.parse(readFileSync(path.join(ROOT, "tests", "edge-oracles", name), "utf8")) as {
        cases: unknown[];
      }
    ).cases;
  for (const entry of read("javascript-tokens.json") as { id: string; source: string }[]) {
    records.push({ label: `javascript-tokens.json#${entry.id}`, source: entry.source });
  }
  for (const entry of read("module-specifiers.json") as { id: string; source: string }[]) {
    records.push({ label: `module-specifiers.json#${entry.id}`, source: entry.source });
  }
  for (const entry of read("test-closure.json") as {
    id: string;
    files: { [file: string]: string };
  }[]) {
    for (const [file, source] of Object.entries(entry.files)) {
      records.push({ label: `test-closure.json#${entry.id}/${file}`, source });
    }
  }
  return records;
}

function tracked(): Record[] {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter((file) => SCANNED_EXTENSIONS.includes(path.extname(file)));
  return files.map((file) => ({
    label: file,
    source: readFileSync(path.join(ROOT, file), "utf8"),
  }));
}

/** Every code point alone and after an identifier start: Unicode tables, spaces, line breaks. */
function codepoints(): Record[] {
  const records: Record[] = [];
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    const text = String.fromCodePoint(codePoint);
    const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    records.push({ label, source: text }, { label: `a${label}`, source: `a${text}` });
  }
  return records;
}

/** Fragments that reach the scanner's numeric, escape, template, trivia and specifier branches. */
const FRAGMENTS = [
  "0",
  "1",
  "7",
  "8",
  "9",
  "_",
  ".",
  "e",
  "E",
  "+",
  "-",
  "x",
  "X",
  "b",
  "B",
  "o",
  "O",
  "n",
  "a",
  "f",
  "F",
  "\\",
  "u",
  "{",
  "}",
  "$",
  "${",
  "`",
  '"',
  "'",
  "\n",
  "\r",
  "\r\n",
  "#",
  "!",
  "/",
  "*",
  "<",
  "=",
  ">",
  "|",
  "?",
  "&",
  "^",
  "%",
  "~",
  "@",
  ":",
  ";",
  "(",
  ")",
  ",",
  "[",
  "]",
  " ",
  "\t",
  ...[
    0x2028, 0x2029, 0xd800, 0xdc00, 0x1f600, 0xe9, 0x1680, 0x1685, 0xfffd, 0xfeff, 0xa0, 0x85,
  ].map((code) => String.fromCodePoint(code)),
  "import",
  "export",
  "require",
  "from",
  "mock",
  "module",
  "of",
  "async",
  "constructor",
  "aa",
  "\\u0061",
  "\\u{61}",
  "\\u{1F600}",
  "\\u{110000}",
  "\\uD83D\\uDE00",
  "\\x41",
  "\\0",
  "\\08",
  "\\377",
  "\\400",
  "0x",
  "0b",
  "0o",
  "0X1F",
  "0b101n",
  "0o17n",
  "00",
  "017",
  "019",
  "1_000",
  "1e",
  "1e+",
  ".5",
  "5.",
  "123n",
  "<<<<<<< ",
  "=======",
  ">>>>>>> ",
  "|||||||",
  "#!",
  "//",
  "/*",
  "*/",
  "?.",
  "...",
];

/** Token-level fragments that reach every branch of the specifier scan. */
const SPECIFIER_FRAGMENTS = [
  "import",
  "export",
  "require",
  "from",
  "mock",
  "module",
  "type",
  "x",
  "*",
  "as",
  "{",
  "}",
  "(",
  ")",
  ",",
  ";",
  ".",
  " ",
  "\n",
  '"a"',
  "'b'",
  '""',
  "`c`",
  "`d$" + "{e}f`",
  "1",
  "+",
];

/** Deterministic random fragment strings (xorshift32, fixed seed). */
function fuzz(fragments: readonly string[], seed: number): Record[] {
  let state = seed;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const records: Record[] = [];
  for (let index = 0; index < 300_000; index += 1) {
    const parts: string[] = [];
    for (let count = 1 + (next() % 12); count > 0; count -= 1)
      parts.push(fragments[next() % fragments.length] ?? "");
    records.push({ label: `fuzz#${index}`, source: parts.join("") });
  }
  return records;
}

const CORPORA: { [name: string]: { build: () => Record[]; modes: readonly string[] } } = {
  fixtures: { build: fixtures, modes: ["tokens", "specifiers"] },
  tracked: { build: tracked, modes: ["tokens", "specifiers"] },
  codepoints: { build: codepoints, modes: ["tokens"] },
  fuzz: { build: () => fuzz(FRAGMENTS, 0x2545f491), modes: ["tokens", "specifiers"] },
  "specifier-fuzz": { build: () => fuzz(SPECIFIER_FRAGMENTS, 0x9e3779b9), modes: ["specifiers"] },
};

const selected = process.argv.slice(2).length > 0 ? process.argv.slice(2) : Object.keys(CORPORA);
let failed = false;
for (const name of selected) {
  const corpus = CORPORA[name];
  if (corpus === undefined) throw new Error(`unknown corpus ${name}`);
  const records = corpus.build();
  for (const mode of corpus.modes) {
    const started = performance.now();
    const typescript = mode === "tokens" ? typescriptTokens : typescriptSpecifiers;
    const mismatches: string[] = [];
    let tokens = 0;
    for (let first = 0; first < records.length; first += BATCH) {
      const batch = records.slice(first, first + BATCH);
      const rust = rustRecords(mode, batch);
      batch.forEach((record, index) => {
        const expected = typescript(record.source);
        tokens += expected.split("\n").length - 1;
        if (rust[index] !== expected)
          mismatches.push(`${record.label}\n  ts:   ${expected}\n  rust: ${rust[index]}`);
      });
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `${name} ${mode}: ${records.length} records, ${tokens} lines, ${mismatches.length} mismatches, ${seconds}s`,
    );
    for (const mismatch of mismatches.slice(0, 10))
      console.log(mismatch.replaceAll("\n", "\n    "));
    if (mismatches.length > 0) failed = true;
  }
}
process.exit(failed ? 1 : 0);
