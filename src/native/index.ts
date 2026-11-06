/** Development facade for the Rust migration. This module is not a public npm export yet. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type * as Core from "../core/index.js";
import type { ProcessResult } from "../engine/index.js";

interface NativeBinding {
  canonicalize(value: unknown): string;
  sha256Canonical(value: unknown): string;
  dispatchValue(operation: string, arguments_: unknown[]): string;
  runProcessJson(inputJson: string): Promise<string>;
}

let binding: NativeBinding | undefined;
function native(): NativeBinding {
  if (binding) return binding;
  const require = createRequire(import.meta.url);
  binding = require(
    fileURLToPath(new URL("../../.testforge/native/assertledger.node", import.meta.url)),
  ) as NativeBinding;
  return binding;
}

function boundary<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "InvalidArg") {
      throw new TypeError(error.message, { cause: error });
    }
    throw error;
  }
}

function core<T>(operation: string, arguments_: unknown[]): T {
  return boundary(() => JSON.parse(native().dispatchValue(operation, arguments_)) as T);
}

export function canonicalize(value: unknown): string {
  return boundary(() => native().canonicalize(value));
}

export function sha256Canonical(value: unknown): string {
  return boundary(() => native().sha256Canonical(value));
}

/** Ordinary JSON evidence only; the broader legacy JS object API has not switched over. */
export function decideEvidence(input: unknown): ReturnType<typeof Core.decideEvidence> {
  return core("decideEvidence", [input]);
}

export function replayEvidenceManifest(
  input: unknown,
): ReturnType<typeof Core.replayEvidenceManifest> {
  return core("replayEvidenceManifest", [input]);
}

export function verifyDecisionDigest(input: unknown): ReturnType<typeof Core.verifyDecisionDigest> {
  return core("verifyDecisionDigest", [input]);
}

export function verifyManifestIntegrity(
  input: unknown,
): ReturnType<typeof Core.verifyManifestIntegrity> {
  return core("verifyManifestIntegrity", [input]);
}

export function selectCandidates(input: unknown[], maximum: number): string[] {
  return core("selectCandidates", [input, maximum]);
}

export async function runProcess(input: unknown): Promise<ProcessResult> {
  // Validate before JSON.stringify can erase unsupported values. Native process inputs are JSON.
  const encoded = canonicalize(input);
  return JSON.parse(await native().runProcessJson(encoded)) as ProcessResult;
}
