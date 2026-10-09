import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  type EvidenceManifestV4Contract,
  parseEvidenceManifestV4,
  parseWitnessImportRequest,
  type VerificationRequestV4,
  type WitnessImportRequest,
} from "../contracts/index.js";
import { assertSafeRelativePath, canonicalize, sealManifestArtifact } from "../core/index.js";
import { DEFAULT_CONTAINER_LIMITS } from "./container.js";
import { verifyCampaign } from "./index.js";

/** The backend an operator authorizes for a replay; the witness request never chooses it. */
export type WitnessImportIsolation =
  | { kind: "trusted-local"; environmentAllowlist: readonly string[] }
  | { kind: "windows-native"; environmentAllowlist: readonly string[] }
  | { kind: "container"; image: string; runtimeCommand?: readonly string[] };

export interface WitnessImportOptions {
  /** A new directory outside the repository; manifest.json is written last. */
  out: string;
  isolation: WitnessImportIsolation;
}

export const DEFAULT_WITNESS_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
] as const;

const WITNESS_CANDIDATE_ID = "witness";

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isWithin(candidate: string, root: string): boolean {
  const relation = path.relative(root, candidate);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation))
  );
}

/**
 * Builds the v4 campaign of a recorded witness: the repository as the reference, the mutated
 * targets as the one target world, and the operator's neutral control, or an identity control
 * whose limit the manifest states. Each target must still hold the recorded base bytes.
 */
export async function witnessVerificationRequest(
  witness: WitnessImportRequest,
  isolation: WitnessImportIsolation,
): Promise<VerificationRequestV4> {
  const root = await realpath(witness.repository.root);
  if (!(await stat(root)).isDirectory()) throw new Error("WITNESS_REPOSITORY_INVALID");
  const targets = [];
  for (const target of witness.targets) {
    let safePath: string;
    try {
      safePath = assertSafeRelativePath(target.path, ["."]);
    } catch {
      throw new Error("WITNESS_TARGET_PATH_INVALID", { cause: target.path });
    }
    let bytes: Buffer;
    try {
      const file = path.join(root, ...safePath.split("/"));
      if (!(await lstat(file)).isFile()) throw new Error("not a regular file");
      bytes = await readFile(file);
    } catch {
      throw new Error("WITNESS_TARGET_BASE_MISMATCH", { cause: safePath });
    }
    if (digestBytes(bytes) !== target.beforeDigest) {
      throw new Error("WITNESS_TARGET_BASE_MISMATCH", { cause: safePath });
    }
    if (bytes.equals(Buffer.from(target.content, "utf8"))) {
      throw new Error("WITNESS_TARGET_UNCHANGED", { cause: safePath });
    }
    targets.push({ path: safePath, content: target.content });
  }
  const overlayBytes = (files: ReadonlyArray<{ content: string }>) =>
    files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
  const neutralFiles = witness.neutral?.files ?? [];
  const attempts = witness.requiredAttempts;
  return {
    schemaVersion: "4.0.0",
    repository: {
      root,
      exclude: [...witness.repository.exclude],
      includeDependencies: witness.repository.includeDependencies,
      git: witness.repository.git,
    },
    adapter: { ...witness.adapter },
    isolation:
      isolation.kind === "container"
        ? {
            kind: "container",
            image: isolation.image,
            environment: [],
            limits: { ...DEFAULT_CONTAINER_LIMITS },
          }
        : {
            kind: isolation.kind,
            acknowledgedUnsafeExecution: true,
            environmentAllowlist: [...isolation.environmentAllowlist],
          },
    candidateRoots: [witness.test.file],
    budgets: {
      maximumCandidates: 1,
      maximumWorlds: 3,
      maximumExecutions: 3 * attempts * 2,
      maximumRepositoryFiles: 2_000_000,
      maximumRepositoryBytes: 20_000_000_000,
      maximumWorldOverlayBytes: Math.max(1, overlayBytes(targets) + overlayBytes(neutralFiles)),
      maximumCandidateBytes: 1,
      maximumTotalCandidateBytes: 1,
      timeoutMsPerExecution: witness.timeoutMsPerExecution,
      maximumOutputBytes: 1_048_576,
    },
    policy: {
      policyVersion: "1.0.0",
      requiredAttempts: attempts,
      minimumTargetWeightPermille: 1_000,
      maximumSelectedCandidates: 1,
      acceptedTargetOutcomes: ["ASSERTION_FAILURE"],
    },
    worlds: [
      {
        id: "reference",
        kind: "REFERENCE",
        required: true,
        weight: 0,
        provenance: `${witness.provenance} | repository snapshot`,
        files: [],
      },
      {
        id: "mutant",
        kind: "TARGET",
        required: true,
        weight: 1,
        provenance: `${witness.provenance} | recorded mutated targets`,
        files: targets,
      },
      {
        id: "neutral",
        kind: "NEUTRAL",
        required: true,
        weight: 0,
        provenance:
          witness.neutral === null
            ? `${witness.provenance} | identity control: repeats the repository snapshot`
            : `${witness.provenance} | ${witness.neutral.reason}`,
        files: neutralFiles.map((file) => ({ path: file.path, content: file.content })),
      },
    ],
    candidates: [
      {
        id: WITNESS_CANDIDATE_ID,
        test: { file: witness.test.file, path: [...witness.test.path] },
        expectedFailure: witness.expectedFailure,
      },
    ],
  };
}

function renderSummary(
  manifest: EvidenceManifestV4Contract,
  witness: WitnessImportRequest,
  manifestPath: string,
): string {
  const runs = (worldId: string) =>
    manifest.observations
      .filter((run) => run.candidateId === WITNESS_CANDIDATE_ID && run.worldId === worldId)
      .map((run) => `attempt ${run.attempt}: ${run.outcome}, attributed=${String(run.attributed)}`)
      .join("; ") || "none";
  return [
    "# AssertLedger witness replay",
    "",
    `- Verdict: **${manifest.decision.status}**`,
    `- Designated test: ${JSON.stringify(witness.test.file)} › ${witness.test.path.map((name) => JSON.stringify(name)).join(" › ")}`,
    `- Expected failure line: ${JSON.stringify(witness.expectedFailure)}`,
    `- Mutant observations: ${runs("mutant")}`,
    `- Reference observations: ${runs("reference")}`,
    `- Reason codes: ${manifest.decision.reasonCodes.join(", ") || "none"}`,
    `- Isolation: **${manifest.isolation.level}**`,
    `- Omitted repository links: ${manifest.evidenceContext.repository.omittedLinks.length}`,
    "",
    "## Limitations",
    "",
    ...manifest.limitations.map((limitation) => `- ${limitation}`),
    "",
    `Replay: assertledger replay ${JSON.stringify(manifestPath)} --json`,
    "",
  ].join("\n");
}

/**
 * Replays a recorded red/green witness as a v4 campaign and saves executed-request.json,
 * summary.md and, last, manifest.json in a new directory outside the repository.
 */
export async function importWitness(
  value: unknown,
  options: WitnessImportOptions,
): Promise<EvidenceManifestV4Contract> {
  const witness = parseWitnessImportRequest(value);
  const request = await witnessVerificationRequest(witness, options.isolation);
  const output = path.resolve(options.out);
  const parent = await realpath(path.dirname(output));
  const target = path.join(parent, path.basename(output));
  if (isWithin(target, request.repository.root))
    throw new Error("WITNESS_OUTPUT_INSIDE_REPOSITORY");
  try {
    await mkdir(target, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("WITNESS_OUTPUT_EXISTS");
    throw error;
  }
  let completed = false;
  try {
    const source = parseEvidenceManifestV4(
      await verifyCampaign(
        request,
        options.isolation.kind === "container" && options.isolation.runtimeCommand !== undefined
          ? { containerRuntime: { command: options.isolation.runtimeCommand } }
          : {},
      ),
    );
    const manifest = parseEvidenceManifestV4(
      sealManifestArtifact({
        ...source,
        limitations: [
          ...source.limitations,
          "The witness import replays operator-recorded targets; AssertLedger checked each target's recorded base digest against the repository and does not infer the fault's meaning.",
          witness.neutral === null
            ? "The neutral control repeats the reference snapshot and provides no independent robustness evidence."
            : "The operator supplied the neutral control and its reason; AssertLedger does not infer its independence.",
        ],
      }),
    );
    const manifestPath = path.join(target, "manifest.json");
    await writeFile(path.join(target, "executed-request.json"), `${canonicalize(request)}\n`, {
      flag: "wx",
    });
    await writeFile(
      path.join(target, "summary.md"),
      renderSummary(manifest, witness, manifestPath),
      { flag: "wx" },
    );
    const pending = path.join(target, ".manifest.tmp");
    await writeFile(pending, `${canonicalize(manifest)}\n`, { flag: "wx" });
    await rename(pending, manifestPath);
    completed = true;
    return manifest;
  } finally {
    if (!completed) {
      for (const name of [".manifest.tmp", "summary.md", "executed-request.json"]) {
        await rm(path.join(target, name), { force: true });
      }
      await rmdir(target).catch(() => undefined);
    }
  }
}
