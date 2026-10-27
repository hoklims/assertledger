import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { PACKAGE_ROOT, runCliCase } from "./support/goldens.js";

/** One real document produced by a published version, frozen with what that version decided. */
interface CorpusEntry {
  id: string;
  kind: "evidence" | "qualification";
  schemaVersion: string;
  producer: string;
  document: string;
  sha256: string;
  decision: string;
  decisionDigest: string;
  artifactDigest: string;
  command: "replay" | "qualification-replay";
  replay: Record<string, unknown>;
  replayedBy: string[];
  input?: string;
  /** The entry whose candidates this one rewrites; both must reach the same verdicts. */
  rewriteOf?: string;
}

interface CandidateFile {
  path: string;
  content: string;
}

interface ManifestCandidate {
  id: string;
  status: string;
  killedTargetIds: string[];
  targetWeightKilled: number;
  reasonCodes: string[];
  gates: Array<{ name: string; status: string; reasonCodes: string[] }>;
}

interface ManifestObservation {
  candidateId: string | null;
  worldId: string;
  attempt: number;
  outcome: string;
  attributed: boolean;
}

const CORPUS_ROOT = path.join(PACKAGE_ROOT, "tests", "replay-corpus");
const corpus = JSON.parse(await readFile(path.join(CORPUS_ROOT, "corpus.json"), "utf8")) as {
  entries: CorpusEntry[];
};

async function documentBytes(entry: CorpusEntry): Promise<Buffer> {
  const bytes = await readFile(path.join(PACKAGE_ROOT, entry.document));
  return entry.document.endsWith(".gz") ? gunzipSync(bytes) : bytes;
}

async function readJson<T>(...segments: string[]): Promise<T> {
  return JSON.parse(await readFile(path.join(PACKAGE_ROOT, ...segments), "utf8")) as T;
}

const V3_HEADER =
  'import { test } from "bun:test";\nimport { assertSame } from "assertledger/bun";\n';

/** Rewrites the single `assertSame(a, b)` of a v3 candidate to Bun's `expect(a).toBe(b)`. */
function rewriteAssertSame(source: string): string {
  assert.ok(source.startsWith(V3_HEADER), "unexpected v3 candidate header");
  const body = source.slice(V3_HEADER.length);
  const call = "assertSame(";
  const start = body.indexOf(call);
  assert.ok(start >= 0 && body.indexOf(call, start + 1) < 0, "expected one assertSame call");
  let depth = 0;
  let comma = -1;
  let end = -1;
  for (let index = start + call.length; index < body.length && end < 0; index += 1) {
    const char = body[index];
    if (char === "(") depth += 1;
    else if (char === ")" && depth > 0) depth -= 1;
    else if (char === "," && depth === 0 && comma < 0) comma = index;
    else if (char === ")") end = index;
  }
  const actual = body.slice(start + call.length, comma).trim();
  const expected = body.slice(comma + 1, end).trim();
  return `import { expect, test } from "bun:test";\n${body.slice(0, start)}expect(${actual}).toBe(${expected})${body.slice(end + 1)}`;
}

/** What a campaign decided, without the digests that bind its contract version. */
function verdicts(manifest: {
  candidates: ManifestCandidate[];
  observations: ManifestObservation[];
}) {
  return {
    candidates: manifest.candidates.map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      killedTargetIds: candidate.killedTargetIds,
      targetWeightKilled: candidate.targetWeightKilled,
      reasonCodes: candidate.reasonCodes,
      gates: candidate.gates.map(({ name, status, reasonCodes }) => ({
        name,
        status,
        reasonCodes,
      })),
    })),
    observations: manifest.observations
      .map(({ candidateId, worldId, attempt, outcome, attributed }) =>
        [candidateId, worldId, attempt, outcome, attributed].join("|"),
      )
      .sort(),
  };
}

describe("frozen replay corpus", () => {
  it("covers evidence manifests v1 to v5 and qualification receipts, each declared once", async () => {
    const ids = corpus.entries.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate corpus id");
    const manifestVersions = new Set(
      corpus.entries
        .filter((entry) => entry.kind === "evidence")
        .map((entry) => entry.schemaVersion),
    );
    assert.deepEqual([...manifestVersions].sort(), ["1.0.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0"]);
    assert.ok(corpus.entries.some((entry) => entry.kind === "qualification"));
    const files = await readdir(path.join(CORPUS_ROOT, "documents"));
    const declared = corpus.entries
      .map((entry) => entry.document)
      .filter((document) => document.startsWith("tests/replay-corpus/documents/"))
      .map((document) => path.basename(document));
    assert.deepEqual(files.sort(), declared.sort());
  });

  for (const entry of corpus.entries) {
    it(`${entry.command} ${entry.id}`, { timeout: 30_000 }, async () => {
      const bytes = await documentBytes(entry);
      // Frozen evidence is never rewritten: the bytes are the ones the producer emitted.
      assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, entry.sha256);
      const document = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      const decision =
        entry.kind === "evidence"
          ? (document.decision as { status: unknown }).status
          : document.decision;
      assert.equal(document.schemaVersion, entry.schemaVersion);
      assert.equal(decision, entry.decision);
      assert.equal(document.decisionDigest, entry.decisionDigest);
      assert.equal(document.artifactDigest, entry.artifactDigest);

      const observed = await runCliCase({
        id: entry.id,
        argv: [entry.command, "-"],
        stdin: bytes.toString("utf8"),
      });
      assert.equal(observed.exitCode, 0, observed.stderr);
      assert.equal(observed.stderr, "");
      // The current build must accept the document exactly as its producer and every later
      // published version did, with byte-identical output.
      assert.equal(observed.stdout, `${JSON.stringify(entry.replay)}\n`);
      assert.equal(entry.replay.valid, true);
    });
  }
});

describe("rewritten v3 candidates", () => {
  const rewrites = corpus.entries.filter((entry) => entry.rewriteOf !== undefined);

  it("rewrite every v3 candidate corpus", () => {
    const v3 = corpus.entries.filter(
      (entry) => entry.kind === "evidence" && entry.schemaVersion === "3.0.0",
    );
    assert.deepEqual(
      rewrites.map((entry) => entry.rewriteOf).sort(),
      v3.map((entry) => entry.id).sort(),
    );
  });

  for (const entry of rewrites) {
    const source = corpus.entries.find((candidate) => candidate.id === entry.rewriteOf);

    it(`${entry.id} designates expect(a).toBe(b) for each assertSame(a, b) of ${entry.rewriteOf}`, async () => {
      assert.ok(source?.input !== undefined && entry.input !== undefined);
      const original = await readJson<{
        worlds: unknown;
        policy: unknown;
        candidates: Array<{ id: string; files: CandidateFile[] }>;
      }>(source.input, "request.json");
      const rewritten = await readJson<{
        worlds: unknown;
        policy: unknown;
        candidates: Array<{ id: string; test: { file: string; path: string[] } }>;
      }>(entry.input, "request.json");
      // Only the assertion changes: same worlds, same policy, one designated test per candidate.
      assert.deepEqual(rewritten.worlds, original.worlds);
      assert.deepEqual(rewritten.policy, original.policy);
      assert.deepEqual(
        rewritten.candidates.map((candidate) => [candidate.id, candidate.test.file]),
        original.candidates.map((candidate) => [candidate.id, candidate.files[0]?.path]),
      );
      for (const candidate of original.candidates) {
        assert.equal(candidate.files.length, 1);
        const [file] = candidate.files as [CandidateFile];
        const content: string = await readFile(
          path.join(PACKAGE_ROOT, entry.input, "repository", file.path),
          "utf8",
        );
        assert.equal(content, rewriteAssertSame(file.content));
        assert.ok(!content.includes("assertledger/bun"));
      }
    });

    it(`${entry.id} reaches the verdicts of ${entry.rewriteOf}`, async () => {
      assert.ok(source !== undefined);
      const original = JSON.parse((await documentBytes(source)).toString("utf8"));
      const rewritten = JSON.parse((await documentBytes(entry)).toString("utf8"));
      assert.deepEqual(rewritten.decision, original.decision);
      assert.deepEqual(verdicts(rewritten), verdicts(original));
    });
  }
});
