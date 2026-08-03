import * as z from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;
export const POLICY_VERSION = "1.0.0" as const;

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

const Sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ReasonCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/);

export const ObservationOutcomeSchema = z.enum([
  "PASS",
  "ASSERTION_FAILURE",
  "COLLECTION_FAILURE",
  "COMPILE_FAILURE",
  "PROCESS_CRASH",
  "TIMEOUT",
  "INFRA_ERROR",
  "NO_TEST_DISCOVERED",
]);

export const FileOverlaySchema = z.strictObject({
  path: z.string().min(1).max(512),
  content: z.string().max(1_048_576),
});

export const WorldSchema = z.strictObject({
  id: IdentifierSchema,
  kind: z.enum(["REFERENCE", "TARGET", "NEUTRAL"]),
  required: z.boolean(),
  weight: z.int().min(0).max(1_000_000),
  provenance: z.string().min(1).max(1_024),
  files: z.array(FileOverlaySchema).max(1_000),
});

export const CandidateSchema = z.strictObject({
  id: IdentifierSchema,
  files: z.array(FileOverlaySchema).min(1).max(100),
});

export const NodeTestAdapterSchema = z.strictObject({
  kind: z.literal("node-test"),
  executable: z.string().min(1),
  baseTestFiles: z.array(z.string().min(1)).min(1).max(1_000),
  extraArguments: z.array(z.string()).max(0).optional(),
});

export const StructuredCommandAdapterSchema = z.strictObject({
  kind: z.literal("testforge-command"),
  executable: z.string().min(1),
  arguments: z.array(z.string()).max(100),
  protocolVersion: z.literal("1.0.0"),
});

export const AdapterSchema = z.discriminatedUnion("kind", [
  NodeTestAdapterSchema,
  StructuredCommandAdapterSchema,
]);

const EnvironmentVariableSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^(?!(?:[Nn][Oo][Dd][Ee]_[Oo][Pp][Tt][Ii][Oo][Nn][Ss]$|[Tt][Ee][Ss][Tt][Ff][Oo][Rr][Gg][Ee]_|[Nn][Oo][Dd][Ee]_[Tt][Ee][Ss][Tt]_)).+$/,
  );

export const TrustedLocalIsolationSchema = z.strictObject({
  kind: z.literal("trusted-local"),
  acknowledgedUnsafeExecution: z.boolean(),
  environmentAllowlist: z.array(EnvironmentVariableSchema).max(100),
});

export const BudgetsSchema = z.strictObject({
  maximumCandidates: z.int().min(1).max(1_000),
  maximumWorlds: z.int().min(3).max(1_000),
  maximumExecutions: z.int().min(1).max(1_000_000),
  maximumRepositoryFiles: z.int().min(1).max(10_000_000),
  maximumRepositoryBytes: z.int().min(1).max(1_000_000_000_000),
  maximumWorldOverlayBytes: z.int().min(1).max(1_000_000_000_000),
  maximumCandidateBytes: z.int().min(1).max(100_000_000),
  maximumTotalCandidateBytes: z.int().min(1).max(100_000_000_000),
  timeoutMsPerExecution: z.int().min(10).max(86_400_000),
  maximumOutputBytes: z.int().min(128).max(100_000_000),
});

export const PolicySchema = z.strictObject({
  policyVersion: z.literal(POLICY_VERSION),
  requiredAttempts: z.int().min(1).max(1_000),
  minimumTargetWeightPermille: z.int().min(1).max(1_000),
  maximumSelectedCandidates: z.int().min(1).max(1_000),
  acceptedTargetOutcomes: z.array(z.literal("ASSERTION_FAILURE")).length(1),
});

export const VerificationRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    repository: z.strictObject({
      root: z.string().min(1),
      exclude: z.array(z.string().min(1).max(512)).max(1_000),
    }),
    adapter: AdapterSchema,
    isolation: TrustedLocalIsolationSchema,
    candidateRoots: z.array(z.string().min(1).max(512)).min(1).max(100),
    budgets: BudgetsSchema,
    policy: PolicySchema,
    worlds: z.array(WorldSchema).min(1).max(1_000),
    candidates: z.array(CandidateSchema).min(1).max(1_000),
  })
  .meta({
    id: "https://testforge.dev/schemas/verification-request.v1.json",
    title: "TestForge verification request",
    description:
      "A versioned campaign describing operator-owned worlds, candidate test overlays, budgets, and evidence policy.",
  });

export const RepositoryAnalysisSchema = z
  .strictObject({
    root: z.string().min(1),
    fileCount: z.int().min(0),
    files: z.array(z.string().min(1).max(1_024)).max(1_000_000),
    languages: z.array(
      z.strictObject({
        name: z.string().min(1).max(128),
        files: z.int().min(1),
      }),
    ),
    detectedTestFrameworks: z.array(z.string().min(1).max(128)),
    repositoryDigest: Sha256DigestSchema,
    capabilities: z.strictObject({
      canExecuteCandidates: z.boolean(),
      supportedAdapters: z.array(z.enum(["node-test", "testforge-command"])),
      isolationLevels: z.array(z.literal("UNSANDBOXED")),
    }),
  })
  .meta({
    id: "https://testforge.dev/schemas/repository-analysis.v1.json",
    title: "TestForge repository analysis",
    description:
      "A deterministic repository inventory and the execution capabilities exposed by TestForge.",
  });

const EvidenceWorldSchema = z.strictObject({
  id: IdentifierSchema,
  kind: z.enum(["REFERENCE", "TARGET", "NEUTRAL"]),
  required: z.boolean(),
  weight: z.int().min(0).max(1_000_000),
});

const EvidenceContextSchema = z.strictObject({
  engine: z.strictObject({
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
  }),
  adapter: z.strictObject({
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
    configuration: z.json(),
  }),
  execution: z.strictObject({
    isolation: z.string().min(1).max(128),
    environmentAllowlist: z.array(z.string().min(1).max(128)).max(100),
    budgets: z.json(),
    candidateRoots: z.array(z.string().min(1).max(512)).max(100),
  }),
  worlds: z.array(
    z.strictObject({
      id: IdentifierSchema,
      provenance: z.string().min(1).max(1_024),
      digest: Sha256DigestSchema,
    }),
  ),
});

export const GateResultSchema = z.strictObject({
  name: z.enum([
    "COMPLETENESS",
    "STABILITY",
    "DISCOVERY",
    "REFERENCE",
    "NEUTRAL",
    "TARGET_STRENGTH",
  ]),
  status: z.enum(["PASSED", "FAILED", "NOT_RUN"]),
  evidenceRunIds: z.array(z.string().min(1).max(512)),
  reasonCodes: z.array(ReasonCodeSchema),
});

export const EvidenceObservationSchema = z.strictObject({
  runId: z.string().min(1).max(512),
  candidateId: IdentifierSchema.nullable(),
  worldId: IdentifierSchema,
  attempt: z.int().min(1),
  outcome: ObservationOutcomeSchema,
  testsDiscovered: z.int().min(0),
  candidateTestsDiscovered: z.int().min(0),
  attributed: z.boolean(),
  durationMs: z.number().finite().min(0).optional(),
  exitCode: z.int().min(0).nullable().optional(),
  stdoutDigest: Sha256DigestSchema.optional(),
  stderrDigest: Sha256DigestSchema.optional(),
});

export const CandidateAssessmentSchema = z.strictObject({
  id: IdentifierSchema,
  digest: Sha256DigestSchema,
  sizeBytes: z.int().min(0),
  status: z.enum(["ELIGIBLE", "UNSTABLE", "INCONCLUSIVE", "INVALID", "WEAK_ORACLE"]),
  killedTargetIds: z.array(IdentifierSchema),
  targetWeightKilled: z.int().min(0),
  gates: z.array(GateResultSchema),
  reasonCodes: z.array(ReasonCodeSchema),
});

const FinalAdapterSummarySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("node-test") }),
  z.strictObject({
    kind: z.literal("testforge-command"),
    protocolVersion: z.literal("1.0.0"),
  }),
]);

const InvalidEvidencePolicySchema = z.strictObject({
  policyVersion: z.literal("invalid"),
  requiredAttempts: z.literal(1),
  minimumTargetWeightPermille: z.literal(1_000),
  maximumSelectedCandidates: z.literal(0),
  acceptedTargetOutcomes: z.array(z.literal("ASSERTION_FAILURE")).max(0),
});

export const EvidenceManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    repositoryDigest: z.union([Sha256DigestSchema, z.literal("invalid")]),
    evidenceContext: EvidenceContextSchema,
    policy: z.union([PolicySchema, InvalidEvidencePolicySchema]),
    worlds: z.array(EvidenceWorldSchema),
    candidates: z.array(CandidateAssessmentSchema),
    observations: z.array(EvidenceObservationSchema),
    decision: z.strictObject({
      status: z.enum(["VERIFIED", "REJECTED", "INCONCLUSIVE", "ENGINE_ERROR"]),
      selectedCandidateIds: z.array(IdentifierSchema),
      reasonCodes: z.array(ReasonCodeSchema),
    }),
    decisionDigest: Sha256DigestSchema,
    artifactDigest: Sha256DigestSchema,
    adapter: FinalAdapterSummarySchema,
    isolation: z.strictObject({
      kind: z.literal("trusted-local"),
      level: z.literal("UNSANDBOXED"),
      acknowledgedUnsafeExecution: z.literal(true),
    }),
    limitations: z.array(z.string().min(1).max(2_048)),
  })
  .meta({
    id: "https://testforge.dev/schemas/evidence-manifest.v1.json",
    title: "TestForge evidence manifest",
    description:
      "The final auditable campaign artifact, including evidence, deterministic gates, decisions, and integrity digests.",
  });

export const ReplayResultSchema = z
  .strictObject({
    valid: z.boolean(),
    schemaValid: z.boolean(),
    decisionDigestValid: z.boolean(),
    artifactDigestValid: z.boolean(),
    decisionSemanticsValid: z.boolean(),
  })
  .meta({
    id: "https://testforge.dev/schemas/replay-result.v1.json",
    title: "TestForge replay result",
    description:
      "Independent integrity and semantic replay verdicts for a TestForge evidence manifest.",
  });

export type ObservationOutcome = z.infer<typeof ObservationOutcomeSchema>;
export type FileOverlay = z.infer<typeof FileOverlaySchema>;
export type World = z.infer<typeof WorldSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type VerificationRequest = z.infer<typeof VerificationRequestSchema>;
export type NodeTestAdapter = z.infer<typeof NodeTestAdapterSchema>;
export type StructuredCommandAdapter = z.infer<typeof StructuredCommandAdapterSchema>;
export type RepositoryAnalysis = z.infer<typeof RepositoryAnalysisSchema>;
export type EvidenceManifestContract = z.infer<typeof EvidenceManifestSchema>;
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

export class ContractError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "ContractError";
    this.code = code;
  }
}

function assertUniqueIdentifiers(items: ReadonlyArray<{ id: string }>, code: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new ContractError(code, item.id);
    }
    seen.add(item.id);
  }
}

function assertWorldKinds(request: VerificationRequest): void {
  if (!request.worlds.some((world) => world.kind === "REFERENCE" && world.required)) {
    throw new ContractError("REFERENCE_WORLD_REQUIRED");
  }
  if (!request.worlds.some((world) => world.kind === "TARGET" && world.required)) {
    throw new ContractError("TARGET_WORLD_REQUIRED");
  }
  if (!request.worlds.some((world) => world.kind === "NEUTRAL" && world.required)) {
    throw new ContractError("NEUTRAL_WORLD_REQUIRED");
  }

  for (const world of request.worlds) {
    if (world.kind === "TARGET" && world.weight < 1) {
      throw new ContractError("TARGET_WEIGHT_REQUIRED", world.id);
    }
    if (world.kind !== "TARGET" && world.weight !== 0) {
      throw new ContractError("NON_TARGET_WEIGHT_FORBIDDEN", world.id);
    }
  }
}

function assertBudgets(request: VerificationRequest): void {
  if (request.candidates.length > request.budgets.maximumCandidates) {
    throw new ContractError("CANDIDATE_BUDGET_EXCEEDED");
  }
  if (request.worlds.length > request.budgets.maximumWorlds) {
    throw new ContractError("WORLD_BUDGET_EXCEEDED");
  }

  const executions =
    request.worlds.length * request.policy.requiredAttempts * (request.candidates.length + 1);
  if (executions > request.budgets.maximumExecutions) {
    throw new ContractError(
      "EXECUTION_BUDGET_EXCEEDED",
      `planned=${executions}, maximum=${request.budgets.maximumExecutions}`,
    );
  }

  const worldOverlayBytes = request.worlds.reduce(
    (worldTotal, world) =>
      worldTotal +
      world.files.reduce(
        (fileTotal, file) => fileTotal + Buffer.byteLength(file.content, "utf8"),
        0,
      ),
    0,
  );
  if (worldOverlayBytes > request.budgets.maximumWorldOverlayBytes) {
    throw new ContractError(
      "WORLD_OVERLAY_BYTES_EXCEEDED",
      `${worldOverlayBytes} > ${request.budgets.maximumWorldOverlayBytes}`,
    );
  }

  let totalCandidateBytes = 0;
  for (const candidate of request.candidates) {
    const bytes = candidate.files.reduce(
      (total, file) => total + Buffer.byteLength(file.content, "utf8"),
      0,
    );
    totalCandidateBytes += bytes;
    if (bytes > request.budgets.maximumCandidateBytes) {
      throw new ContractError(
        "CANDIDATE_BYTES_EXCEEDED",
        `${candidate.id}: ${bytes} > ${request.budgets.maximumCandidateBytes}`,
      );
    }
  }
  if (totalCandidateBytes > request.budgets.maximumTotalCandidateBytes) {
    throw new ContractError(
      "TOTAL_CANDIDATE_BYTES_EXCEEDED",
      `${totalCandidateBytes} > ${request.budgets.maximumTotalCandidateBytes}`,
    );
  }
}

function findUnsafeNodeTestArgument(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("adapter" in value)) return undefined;
  const adapter = value.adapter;
  if (
    typeof adapter !== "object" ||
    adapter === null ||
    !("kind" in adapter) ||
    adapter.kind !== "node-test" ||
    !("extraArguments" in adapter) ||
    !Array.isArray(adapter.extraArguments)
  ) {
    return undefined;
  }
  if (adapter.extraArguments.length === 0) return undefined;
  const firstArgument = adapter.extraArguments[0];
  return typeof firstArgument === "string" ? firstArgument : "non-string argument";
}

function findReservedEnvironmentVariable(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("isolation" in value)) return undefined;
  const isolation = value.isolation;
  if (
    typeof isolation !== "object" ||
    isolation === null ||
    !("environmentAllowlist" in isolation) ||
    !Array.isArray(isolation.environmentAllowlist)
  ) {
    return undefined;
  }
  return isolation.environmentAllowlist.find((variable): variable is string => {
    if (typeof variable !== "string") return false;
    const normalized = variable.toUpperCase();
    return (
      normalized === "NODE_OPTIONS" ||
      normalized.startsWith("TESTFORGE_") ||
      normalized.startsWith("NODE_TEST_")
    );
  });
}

export function parseVerificationRequest(value: unknown): VerificationRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== SCHEMA_VERSION
  ) {
    throw new ContractError("SCHEMA_VERSION_UNSUPPORTED");
  }

  const rawPolicy = "policy" in value ? value.policy : undefined;
  if (
    typeof rawPolicy === "object" &&
    rawPolicy !== null &&
    "acceptedTargetOutcomes" in rawPolicy &&
    Array.isArray(rawPolicy.acceptedTargetOutcomes) &&
    rawPolicy.acceptedTargetOutcomes.some((outcome) => outcome !== "ASSERTION_FAILURE")
  ) {
    throw new ContractError(
      "UNSAFE_TARGET_OUTCOME",
      "v1 only admits attributed assertion failures as target evidence",
    );
  }

  const unsafeNodeTestArgument = findUnsafeNodeTestArgument(value);
  if (unsafeNodeTestArgument !== undefined) {
    throw new ContractError("UNSAFE_NODE_TEST_ARGUMENT", unsafeNodeTestArgument);
  }

  const reservedEnvironmentVariable = findReservedEnvironmentVariable(value);
  if (reservedEnvironmentVariable !== undefined) {
    throw new ContractError("RESERVED_ENVIRONMENT_VARIABLE", reservedEnvironmentVariable);
  }

  const parsed = VerificationRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("REQUEST_SCHEMA_INVALID", z.prettifyError(parsed.error));
  }

  const request = parsed.data;
  assertUniqueIdentifiers(request.worlds, "DUPLICATE_WORLD_ID");
  assertUniqueIdentifiers(request.candidates, "DUPLICATE_CANDIDATE_ID");
  assertWorldKinds(request);
  assertBudgets(request);

  return request;
}

export function parseRepositoryAnalysis(value: unknown): RepositoryAnalysis {
  const parsed = RepositoryAnalysisSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("REPOSITORY_ANALYSIS_INVALID", z.prettifyError(parsed.error));
  }
  if (parsed.data.fileCount !== parsed.data.files.length) {
    throw new ContractError(
      "REPOSITORY_ANALYSIS_INCONSISTENT",
      `fileCount=${parsed.data.fileCount}, files=${parsed.data.files.length}`,
    );
  }
  return parsed.data;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestSummariesAreConsistent(manifest: EvidenceManifestContract): boolean {
  const engineError = manifest.decision.status === "ENGINE_ERROR";
  const invalidEvidence =
    manifest.repositoryDigest === "invalid" || manifest.policy.policyVersion === "invalid";
  if (engineError !== invalidEvidence) return false;
  if (engineError) return true;

  if (
    manifest.adapter.kind !== manifest.evidenceContext.adapter.name ||
    manifest.isolation.level !== manifest.evidenceContext.execution.isolation
  ) {
    return false;
  }

  const configuration = manifest.evidenceContext.adapter.configuration;
  if (!isJsonObject(configuration) || configuration.kind !== manifest.adapter.kind) return false;

  if (manifest.adapter.kind === "testforge-command") {
    return (
      manifest.adapter.protocolVersion === manifest.evidenceContext.adapter.version &&
      configuration.protocolVersion === manifest.adapter.protocolVersion
    );
  }
  return true;
}

export function parseEvidenceManifest(value: unknown): EvidenceManifestContract {
  const parsed = EvidenceManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("EVIDENCE_MANIFEST_INVALID", z.prettifyError(parsed.error));
  }
  const manifest = parsed.data;
  const worldIds = new Set(manifest.worlds.map((world) => world.id));
  const candidateIds = new Set(manifest.candidates.map((candidate) => candidate.id));
  const runIds = new Set(manifest.observations.map((observation) => observation.runId));
  const contextWorldIds = new Set(manifest.evidenceContext.worlds.map((world) => world.id));
  const inconsistent =
    !manifestSummariesAreConsistent(manifest) ||
    worldIds.size !== manifest.worlds.length ||
    candidateIds.size !== manifest.candidates.length ||
    runIds.size !== manifest.observations.length ||
    contextWorldIds.size !== manifest.evidenceContext.worlds.length ||
    contextWorldIds.size !== worldIds.size ||
    [...contextWorldIds].some((id) => !worldIds.has(id)) ||
    manifest.decision.selectedCandidateIds.some((id) => !candidateIds.has(id)) ||
    manifest.observations.some(
      (observation) =>
        !worldIds.has(observation.worldId) ||
        observation.candidateTestsDiscovered > observation.testsDiscovered ||
        (observation.candidateId !== null && !candidateIds.has(observation.candidateId)),
    ) ||
    manifest.candidates.some(
      (candidate) =>
        candidate.killedTargetIds.some((id) => !worldIds.has(id)) ||
        candidate.gates.some((gate) => gate.evidenceRunIds.some((id) => !runIds.has(id))),
    );
  if (inconsistent) {
    throw new ContractError("EVIDENCE_MANIFEST_INCONSISTENT");
  }
  return manifest;
}

export function parseReplayResult(value: unknown): ReplayResult {
  const parsed = ReplayResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("REPLAY_RESULT_INVALID", z.prettifyError(parsed.error));
  }
  const result = parsed.data;
  if (
    result.valid !==
    (result.schemaValid &&
      result.decisionDigestValid &&
      result.artifactDigestValid &&
      result.decisionSemanticsValid)
  ) {
    throw new ContractError("REPLAY_RESULT_INCONSISTENT");
  }
  return result;
}

function jsonSchemaFor(schema: z.ZodType, id: string): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    reused: "ref",
  }) as Record<string, unknown>;
  return {
    ...generated,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
  };
}

export function verificationRequestJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    VerificationRequestSchema,
    "https://testforge.dev/schemas/verification-request.v1.json",
  );
}

export function repositoryAnalysisJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    RepositoryAnalysisSchema,
    "https://testforge.dev/schemas/repository-analysis.v1.json",
  );
}

export function evidenceManifestJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    EvidenceManifestSchema,
    "https://testforge.dev/schemas/evidence-manifest.v1.json",
  );
}

export function replayResultJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(ReplayResultSchema, "https://testforge.dev/schemas/replay-result.v1.json");
}
