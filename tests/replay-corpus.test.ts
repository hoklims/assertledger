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
}

const CORPUS_ROOT = path.join(PACKAGE_ROOT, "tests", "replay-corpus");
const corpus = JSON.parse(await readFile(path.join(CORPUS_ROOT, "corpus.json"), "utf8")) as {
  entries: CorpusEntry[];
};

async function documentBytes(entry: CorpusEntry): Promise<Buffer> {
  const bytes = await readFile(path.join(PACKAGE_ROOT, entry.document));
  return entry.document.endsWith(".gz") ? gunzipSync(bytes) : bytes;
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
