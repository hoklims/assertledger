#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { canonicalize } from "../src/core/index.js";
import {
  AgenticCorpusError,
  evaluateAgenticCorpusHoldout,
  evaluateAgenticCorpusPublic,
  inspectAgenticCorpus,
  parseAgenticCorpusCase,
  replayAgenticCorpusProvenance,
} from "../src/evaluation/agentic-corpus.js";

const SCHEMA_VERSION = "1.0.0";

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function invalid(reasonCode: string): number {
  write({ schemaVersion: SCHEMA_VERSION, status: "INVALID_CORPUS", reasonCodes: [reasonCode] });
  return 4;
}

async function main(argv: string[]): Promise<number> {
  const trustIndex = argv.indexOf("--trust-policy");
  const digestIndex = argv.indexOf("--trust-policy-digest");
  if ((trustIndex === -1) !== (digestIndex === -1)) return invalid("USAGE_INVALID");
  let trust: { policy: unknown; expectedPolicyDigest: string } | undefined;
  if (trustIndex !== -1 && digestIndex !== -1) {
    const policyPath = argv[trustIndex + 1];
    const expectedPolicyDigest = argv[digestIndex + 1];
    if (policyPath === undefined || expectedPolicyDigest === undefined)
      return invalid("USAGE_INVALID");
    try {
      trust = {
        policy: JSON.parse(await readFile(policyPath, "utf8")) as unknown,
        expectedPolicyDigest,
      };
    } catch {
      return invalid("PROVENANCE_POLICY_INVALID");
    }
    argv = argv.filter(
      (_, index) =>
        index !== trustIndex &&
        index !== trustIndex + 1 &&
        index !== digestIndex &&
        index !== digestIndex + 1,
    );
  }
  const [command, root, sidecarPath] = argv;
  if (command === "replay-provenance") {
    if (
      argv.length !== 3 ||
      root === undefined ||
      sidecarPath === undefined ||
      trust === undefined
    ) {
      return invalid("USAGE_INVALID");
    }
    try {
      const caseValue = JSON.parse(await readFile(root, "utf8")) as unknown;
      const sidecarText = await readFile(sidecarPath, "utf8");
      const sidecarValue = JSON.parse(sidecarText) as unknown;
      if (`${canonicalize(sidecarValue)}\n` !== sidecarText)
        return invalid("PROVENANCE_JSON_NONCANONICAL");
      parseAgenticCorpusCase(caseValue);
      const replay = replayAgenticCorpusProvenance(
        caseValue,
        sidecarValue,
        trust.policy,
        trust.expectedPolicyDigest,
      );
      write(replay);
      return replay.valid ? 0 : 4;
    } catch (error) {
      return invalid(error instanceof AgenticCorpusError ? error.code : "PROVENANCE_INVALID");
    }
  }
  if (argv.length !== 2 || root === undefined) return invalid("USAGE_INVALID");
  try {
    const result =
      command === "status"
        ? await inspectAgenticCorpus(root, trust)
        : command === "evaluate-public"
          ? await evaluateAgenticCorpusPublic(root, trust)
          : command === "evaluate-holdout"
            ? await evaluateAgenticCorpusHoldout(root, trust)
            : undefined;
    if (result === undefined) return invalid("USAGE_INVALID");
    write(result);
    return result.status === "NOT_READY" ? 3 : result.status === "INVALID_CORPUS" ? 4 : 0;
  } catch (error) {
    return invalid(error instanceof AgenticCorpusError ? error.code : "CORPUS_IO_ERROR");
  }
}

process.exitCode = await main(process.argv.slice(2));
