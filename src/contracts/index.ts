import { createHash } from "node:crypto";
import path from "node:path";
import * as z from "zod";

export * from "./runtime-doctor.js";

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

export const StructuredCommandSchema = z.strictObject({
  executable: z.string().min(1).max(512),
  arguments: z.array(z.string().max(1_024)).max(100),
});

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

const NullableNonNegativeIntegerSchema = z.int().min(0).nullable();

export const RepositoryAuditSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0.0"),
    root: z.string().min(1),
    repositoryDigest: Sha256DigestSchema,
    fileCount: z.int().min(0),
    repositoryBytes: z.int().min(0),
    reasonCodes: z.array(ReasonCodeSchema),
    git: z.strictObject({
      supported: z.boolean(),
      headTimestamp: z.int().min(0).nullable(),
      windowDays: z.literal(90),
      maximumCommits: z.literal(1_000),
      shallow: z.boolean().nullable(),
      truncated: z.boolean().nullable(),
    }),
    files: z.array(
      z.strictObject({
        path: z.string().min(1).max(1_024),
        language: z.string().min(1).max(128).nullable(),
        supported: z.boolean(),
        bytes: z.int().min(0),
        decisionPoints: NullableNonNegativeIntegerSchema,
        declaredExports: z.array(z.string().min(1).max(256)).nullable(),
        noObservedTestReference: z.array(z.string().min(1).max(256)).nullable(),
        associatedTests: z.array(z.string().min(1).max(1_024)),
        sourceChangedAfterAssociatedTest: z.boolean().nullable(),
        commitsInWindow: NullableNonNegativeIntegerSchema,
        fixCommitsInWindow: NullableNonNegativeIntegerSchema,
        weakAssertions: z
          .array(
            z.strictObject({
              category: z.enum([
                "TRUTHINESS_ONLY",
                "CONSTANT_BOOLEAN_EQUALITY",
                "DEFINEDNESS_ONLY",
                "NON_THROW_ONLY",
                "TYPE_ONLY",
              ]),
              count: z.int().min(1),
            }),
          )
          .nullable(),
      }),
    ),
    modules: z.array(
      z.strictObject({
        pathPrefix: z.string().min(1).max(1_024),
        rank: z.int().min(1),
        files: z.int().min(1),
        factualTuple: z.tuple([
          z.int().min(0),
          z.int().min(0),
          z.int().min(0),
          z.int().min(0),
          z.int().min(0),
          z.int().min(0),
        ]),
      }),
    ),
    cost: z.strictObject({
      candidates: z.int().min(0),
      worlds: z.int().min(0),
      attempts: z.int().min(0),
      executions: z.string().regex(/^\d+$/),
      controlExecutions: z.string().regex(/^\d+$/),
      candidateExecutions: z.string().regex(/^\d+$/),
      overlayBytes: z.string().regex(/^\d+$/),
      materializationBytes: z.string().regex(/^\d+$/),
      timeoutLimitMs: z.string().regex(/^\d+$/),
      capturedStreamLimitBytes: z.string().regex(/^\d+$/),
    }),
    verificationRequest: VerificationRequestSchema.nullable(),
  })
  .meta({
    id: "https://testforge.dev/schemas/repository-audit.v1.json",
    title: "AssertLedger repository audit",
    description: "A deterministic static repository audit and campaign cost projection.",
  });

const RepositoryInitEvidenceSchema = z.strictObject({
  path: z.string().min(1).max(1_024),
  digest: Sha256DigestSchema,
  kind: z.enum(["PACKAGE_MANIFEST", "LOCKFILE", "TEST_SOURCE", "CI_CONFIG", "ADAPTER_CONFIG"]),
});

export const RepositoryInitDetectionsSchema = z.strictObject({
  packageManager: z.enum(["pnpm", "npm", "yarn", "bun", "uv", "poetry", "pip"]).nullable(),
  framework: z.enum(["node:test", "vitest", "jest", "bun:test", "pytest"]).nullable(),
  testCommand: StructuredCommandSchema.nullable(),
  ciProviders: z.array(z.enum(["github-actions", "gitlab-ci", "azure-pipelines", "circleci"])),
  adapterRecommendation: z.enum(["node-test", "operator-supplied", "unavailable"]),
  reasonCodes: z.array(ReasonCodeSchema),
});

export const RepositoryInitConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    repository: z.strictObject({
      root: z.literal("."),
      exclude: z.array(z.string().min(1).max(512)).max(1_000),
    }),
    packageManager: z.enum(["pnpm", "npm", "yarn", "bun", "uv", "poetry", "pip"]),
    framework: z.enum(["node:test", "vitest", "jest", "bun:test", "pytest"]),
    testCommand: StructuredCommandSchema,
    adapter: AdapterSchema,
    candidateRoots: z.array(z.string().min(1).max(512)).min(1).max(100),
  })
  .meta({
    id: "https://testforge.dev/schemas/repository-init-config.v1.json",
    title: "AssertLedger repository init config",
    description: "Portable static configuration produced by assertledger init.",
  });

export const RepositoryInitLockSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    configDigest: Sha256DigestSchema,
    detector: z.strictObject({
      name: z.literal("assertledger-init"),
      version: z.literal("1.0.0"),
    }),
    evidence: z.array(RepositoryInitEvidenceSchema),
    detections: RepositoryInitDetectionsSchema,
    lockDigest: Sha256DigestSchema,
  })
  .meta({
    id: "https://testforge.dev/schemas/repository-init-lock.v1.json",
    title: "AssertLedger repository init lock",
    description: "Deterministic evidence lock binding an initialized repository configuration.",
  });

export const RepositoryInitResultSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    status: z.enum(["CREATED", "UNCHANGED", "WOULD_CREATE", "BLOCKED", "CONFLICT"]),
    reasonCodes: z.array(ReasonCodeSchema),
    detections: RepositoryInitDetectionsSchema,
    actions: z.array(
      z.strictObject({
        kind: z.enum(["CREATE", "REGENERATE"]),
        path: z.enum(["assertledger.config.json", "assertledger.lock.json"]),
      }),
    ),
    files: z.array(
      z.strictObject({
        path: z.enum(["assertledger.config.json", "assertledger.lock.json"]),
        digest: Sha256DigestSchema,
        content: z
          .string()
          .min(1)
          .max(16 * 1024 * 1024),
      }),
    ),
    requiredOperatorInputs: z.tuple([z.literal("worlds"), z.literal("candidates")]),
    nextCommands: z.array(StructuredCommandSchema),
  })
  .meta({
    id: "https://testforge.dev/schemas/repository-init-result.v1.json",
    title: "AssertLedger repository init result",
    description: "Deterministic initialization plan and outcome without campaign execution.",
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

export const AgenticProfileLaneSchema = z.strictObject({
  id: IdentifierSchema,
  maximumReferenceP95Ms: z.int().min(1).max(86_400_000),
});

export const AgenticProfilePolicySchema = z.strictObject({
  profileVersion: z.literal("1.0.0"),
  profileId: z.string().min(1).max(256),
  mode: z.literal("HARDENING"),
  minimumTimingSamples: z.int().min(1).max(1_000),
  lanes: z.array(AgenticProfileLaneSchema).min(1).max(100),
});

// Embedded copies deliberately omit the standalone manifest's schema id. Some JSON Schema
// consumers interpret a nested id as a new resolution scope and cannot resolve its local $defs.
const EmbeddedEvidenceManifestSchema = z.strictObject({ ...EvidenceManifestSchema.shape });

export const AgenticProfileRequestSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0.0"),
    manifest: EmbeddedEvidenceManifestSchema,
    policy: AgenticProfilePolicySchema,
  })
  .meta({
    id: "https://testforge.dev/schemas/agentic-profile-request.v1.json",
    title: "TestForge Agentic Test Profile request",
    description: "A replay-valid evidence manifest and repository-scoped feedback policy.",
  });

const AgenticProfileClassificationSchema = z.enum([
  "QUALIFIED",
  "BUDGET_MISSED",
  "INSUFFICIENT_TIMING_EVIDENCE",
  "NOT_QUALIFIED",
]);

const AgenticProfileCandidateSchema = z.strictObject({
  id: IdentifierSchema,
  evidenceStatus: z.enum(["ELIGIBLE", "UNSTABLE", "INCONCLUSIVE", "INVALID", "WEAK_ORACLE"]),
  classification: AgenticProfileClassificationSchema,
  satisfiedLaneIds: z.array(IdentifierSchema),
  bestLaneId: IdentifierSchema.nullable(),
  targetWeightKilled: z.int().min(0),
  totalTargetWeight: z.int().min(0),
  targetWeightPermille: z.int().min(0).max(1_000),
  requiredTargetsKilled: z.int().min(0),
  requiredTargetsTotal: z.int().min(0),
  killedTargetIds: z.array(IdentifierSchema),
  marginalTargetWeight: z.int().min(0),
  consistency: z.strictObject({
    claim: z.enum(["OBSERVED_CONSISTENT", "OBSERVED_INCONSISTENT"]),
    attempts: z.int().min(0),
  }),
  latency: z.strictObject({
    kind: z.literal("RECORDED_REFERENCE_WALL_TIME"),
    samples: z.int().min(0),
    minimumMs: z.number().finite().min(0).nullable(),
    p50Ms: z.number().finite().min(0).nullable(),
    p95Ms: z.number().finite().min(0).nullable(),
    maximumMs: z.number().finite().min(0).nullable(),
    totalCandidateDurationMs: z.number().finite().min(0),
  }),
  paretoFrontier: z.boolean(),
});

const AgenticProfilePortfolioSchema = z.strictObject({
  laneId: IdentifierSchema,
  budgetMs: z.int().min(1).max(86_400_000),
  selectedCandidateIds: z.array(IdentifierSchema),
  totalReferenceP95Ms: z.number().finite().min(0),
  targetWeight: z.int().min(0),
  targetWeightPermille: z.int().min(0).max(1_000),
  requiredTargetsKilled: z.int().min(0),
  requiredTargetsTotal: z.int().min(0),
});

export const AgenticProfileReportSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0.0"),
    sourceManifest: EmbeddedEvidenceManifestSchema,
    sourceArtifactDigest: Sha256DigestSchema,
    policy: AgenticProfilePolicySchema,
    policyDigest: Sha256DigestSchema,
    status: AgenticProfileClassificationSchema,
    candidates: z.array(AgenticProfileCandidateSchema),
    portfolios: z.array(AgenticProfilePortfolioSchema),
    qualifiedCandidateIds: z.array(IdentifierSchema),
    limitations: z.array(z.string().min(1).max(2_048)),
    reportDigest: Sha256DigestSchema,
  })
  .meta({
    id: "https://testforge.dev/schemas/agentic-profile-report.v1.json",
    title: "TestForge Agentic Test Profile report",
    description: "A self-contained, replayable profile of declared evidence and observed cost.",
  });

export const AgenticProfileReplayResultSchema = z
  .strictObject({
    valid: z.boolean(),
    schemaValid: z.boolean(),
    sourceManifestValid: z.boolean(),
    policyDigestValid: z.boolean(),
    reportDigestValid: z.boolean(),
    semanticsValid: z.boolean(),
  })
  .meta({
    id: "https://testforge.dev/schemas/agentic-profile-replay-result.v1.json",
    title: "TestForge Agentic Test Profile replay result",
    description: "Independent schema, source, digest, and semantic replay verdicts for a profile.",
  });

const BenchmarkPhaseNameSchema = z.enum([
  "PREPARATION",
  "STARTUP",
  "COMPILE_OR_COLLECTION",
  "EXECUTION",
]);

export const AgenticBenchmarkPolicySchema = z.strictObject({
  benchmarkVersion: z.literal("1.0.0"),
  minimumMeasuredSamplesPerRegime: z.int().min(1).max(1_000),
  coldMeasuredSamples: z.int().min(1).max(1_000),
  warmupSamples: z.int().min(1).max(1_000),
  warmMeasuredSamples: z.int().min(1).max(1_000),
  maximumExecutions: z.int().min(1).max(1_000_000),
});

export const AgenticBenchmarkProtocolSchema = z.strictObject({
  protocolVersion: z.literal("1.0.0"),
  clock: z.literal("MONOTONIC"),
  unit: z.literal("MICROSECOND"),
  quantile: z.literal("NEAREST_RANK"),
  phases: z.tuple([
    z.literal("PREPARATION"),
    z.literal("STARTUP"),
    z.literal("COMPILE_OR_COLLECTION"),
    z.literal("EXECUTION"),
  ]),
  coldDefinition: z.literal("FRESH_WORKSPACE_FRESH_PROCESS_RESET_DECLARED_CACHES"),
  warmDefinition: z.literal("FRESH_WORKSPACE_FRESH_PROCESS_RETAIN_DECLARED_CACHES"),
});

const AgenticBenchmarkToolSchema = z.strictObject({
  role: IdentifierSchema,
  name: z.string().min(1).max(256),
  version: z.string().min(1).max(256),
  digest: Sha256DigestSchema,
  configurationDigest: Sha256DigestSchema,
});

export const AgenticBenchmarkFingerprintSchema = z.strictObject({
  environmentId: IdentifierSchema,
  os: z.strictObject({
    platform: z.string().min(1).max(128),
    release: z.string().min(1).max(128),
    arch: z.string().min(1).max(128),
  }),
  cpu: z.strictObject({
    arch: z.string().min(1).max(128),
    model: z.string().min(1).max(512),
    logicalCores: z.int().min(1).max(1_000_000),
  }),
  logicalCpuLimit: z.int().min(1).max(1_000_000).nullable(),
  memoryLimitBytes: z.int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
  executionBoundary: z.literal("UNSANDBOXED"),
  tools: z.array(AgenticBenchmarkToolSchema).min(1).max(100),
  dependencyGraphDigest: Sha256DigestSchema,
  phaseReporterDigest: Sha256DigestSchema,
});

const AgenticBenchmarkPhaseTimingSchema = z.strictObject({
  phase: BenchmarkPhaseNameSchema,
  durationUs: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const AgenticBenchmarkRunBaseSchema = z.strictObject({
  candidateId: IdentifierSchema,
  candidateDigest: Sha256DigestSchema,
  regime: z.enum(["COLD", "WARM"]),
  role: z.enum(["WARMUP", "MEASUREMENT"]),
  ordinal: z.int().min(1).max(1_000_000),
});

const AgenticBenchmarkCompleteRunSchema = AgenticBenchmarkRunBaseSchema.extend({
  status: z.literal("COMPLETE"),
  outcome: z.literal("PASS"),
  phases: z.array(AgenticBenchmarkPhaseTimingSchema).length(4),
  totalUs: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  cpuTimeUs: z.int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

const AgenticBenchmarkIncompleteRunSchema = AgenticBenchmarkRunBaseSchema.extend({
  status: z.literal("INCOMPLETE"),
  outcome: z.enum([
    "ASSERTION_FAILURE",
    "COLLECTION_FAILURE",
    "COMPILE_FAILURE",
    "PROCESS_CRASH",
    "TIMEOUT",
    "INFRA_ERROR",
    "NO_TEST_DISCOVERED",
  ]),
  phases: z.null(),
  totalUs: z.null(),
  cpuTimeUs: z.null(),
});

export const AgenticBenchmarkRunSchema = z.discriminatedUnion("status", [
  AgenticBenchmarkCompleteRunSchema,
  AgenticBenchmarkIncompleteRunSchema,
]);

export const AgenticBenchmarkRequestSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0.0"),
    sourceManifest: EmbeddedEvidenceManifestSchema,
    referenceWorldId: IdentifierSchema,
    policy: AgenticBenchmarkPolicySchema,
    protocol: AgenticBenchmarkProtocolSchema,
    fingerprint: AgenticBenchmarkFingerprintSchema,
    runs: z.array(AgenticBenchmarkRunSchema).max(1_000_000),
  })
  .meta({
    id: "https://testforge.dev/schemas/agentic-benchmark-request.v1.json",
    title: "TestForge Agentic Benchmark request",
    description: "A replay-valid source manifest and raw cold/warm benchmark observations.",
  });

const AgenticBenchmarkQuantilesSchema = z.strictObject({
  minimumUs: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  p50Us: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  p95Us: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  maximumUs: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const AgenticBenchmarkWallSummarySchema = z.strictObject({
  total: AgenticBenchmarkQuantilesSchema.nullable(),
  phases: z.strictObject({
    PREPARATION: AgenticBenchmarkQuantilesSchema.nullable(),
    STARTUP: AgenticBenchmarkQuantilesSchema.nullable(),
    COMPILE_OR_COLLECTION: AgenticBenchmarkQuantilesSchema.nullable(),
    EXECUTION: AgenticBenchmarkQuantilesSchema.nullable(),
  }),
});

const AgenticBenchmarkSummarySchema = z.strictObject({
  candidateId: IdentifierSchema,
  candidateDigest: Sha256DigestSchema,
  regime: z.enum(["COLD", "WARM"]),
  status: z.enum(["MEASURED", "INSUFFICIENT_SAMPLES", "OBSERVED_RUN_FAILURE"]),
  counters: z.strictObject({
    planned: z.int().min(1).max(1_000),
    recorded: z.int().min(0).max(1_000),
    accepted: z.int().min(0).max(1_000),
    failed: z.int().min(0).max(2_000),
    warmup: z.int().min(0).max(1_000),
  }),
  wall: AgenticBenchmarkWallSummarySchema,
  cpu: z.strictObject({
    availability: z.enum(["UNAVAILABLE", "PARTIAL", "COMPLETE"]),
    quantiles: AgenticBenchmarkQuantilesSchema.nullable(),
  }),
});

export const AgenticBenchmarkArtifactSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0.0"),
    sourceManifest: EmbeddedEvidenceManifestSchema,
    sourceArtifactDigest: Sha256DigestSchema,
    sourceDecisionDigest: Sha256DigestSchema,
    referenceWorldId: IdentifierSchema,
    policy: AgenticBenchmarkPolicySchema,
    protocol: AgenticBenchmarkProtocolSchema,
    fingerprint: AgenticBenchmarkFingerprintSchema,
    policyDigest: Sha256DigestSchema,
    protocolDigest: Sha256DigestSchema,
    fingerprintDigest: Sha256DigestSchema,
    comparisonScopeDigest: Sha256DigestSchema,
    runs: z.array(AgenticBenchmarkRunSchema).max(1_000_000),
    summaries: z.array(AgenticBenchmarkSummarySchema).min(1).max(2_000),
    limitations: z.array(z.string().min(1).max(2_048)),
    artifactDigest: Sha256DigestSchema,
  })
  .meta({
    id: "https://testforge.dev/schemas/agentic-benchmark-artifact.v1.json",
    title: "TestForge Agentic Benchmark artifact",
    description: "A self-contained replayable cold/warm benchmark artifact.",
  });

export const AgenticBenchmarkReplayResultSchema = z
  .strictObject({
    valid: z.boolean(),
    schemaValid: z.boolean(),
    sourceManifestValid: z.boolean(),
    sourceBindingValid: z.boolean(),
    policyDigestValid: z.boolean(),
    protocolDigestValid: z.boolean(),
    fingerprintDigestValid: z.boolean(),
    comparisonScopeDigestValid: z.boolean(),
    artifactDigestValid: z.boolean(),
    summarySemanticsValid: z.boolean(),
  })
  .meta({
    id: "https://testforge.dev/schemas/agentic-benchmark-replay-result.v1.json",
    title: "TestForge Agentic Benchmark replay result",
    description: "Independent integrity and semantic replay rails for a benchmark artifact.",
  });

const AgenticBenchmarkAcquisitionIdentityFilesSchema = z.strictObject({
  phaseReporter: z.string().min(1).max(512),
  dependencyGraph: z.array(z.string().min(1).max(512)).min(1).max(100),
});

const EmbeddedVerificationRequestSchema = z.strictObject({ ...VerificationRequestSchema.shape });

export const AgenticBenchmarkAcquisitionRequestSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0.0"),
    verificationRequest: EmbeddedVerificationRequestSchema,
    referenceWorldId: IdentifierSchema,
    policy: AgenticBenchmarkPolicySchema,
    protocol: AgenticBenchmarkProtocolSchema,
    environment: z.strictObject({
      environmentId: IdentifierSchema,
      logicalCpuLimit: z.int().min(1).max(1_000_000).nullable(),
      memoryLimitBytes: z.int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
    }),
    identityFiles: AgenticBenchmarkAcquisitionIdentityFilesSchema,
  })
  .meta({
    id: "https://testforge.dev/schemas/agentic-benchmark-acquisition-request.v1.json",
    title: "TestForge Agentic Benchmark acquisition request",
    description:
      "A fresh verification campaign plus strict phase-aware acquisition policy and identity bindings.",
  });

const AgenticBenchmarkAcquisitionContextSchema = z.strictObject({
  snapshotRepositoryDigest: Sha256DigestSchema,
  referenceWorldId: IdentifierSchema,
  candidateIds: z.array(IdentifierSchema),
  adapter: z.strictObject({
    executable: z.string().min(1),
    arguments: z.array(z.string()).max(100),
    executableDigest: Sha256DigestSchema,
    identityFilePath: z.string().min(1).max(512),
    identityDigest: Sha256DigestSchema,
  }),
  dependencyFiles: z.array(
    z.strictObject({ path: z.string().min(1).max(512), digest: Sha256DigestSchema }),
  ),
  dependencyGraphDigest: Sha256DigestSchema,
  cachePolicy: z.strictObject({
    cold: z.literal("UNIQUE_EMPTY_DIRECTORY_PER_RUN"),
    warm: z.literal("ONE_INITIALLY_EMPTY_DIRECTORY_PER_CANDIDATE"),
    sharedAcrossCandidates: z.literal(false),
  }),
});

export const AgenticBenchmarkAcquisitionResultSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0.0"),
    requestDigest: Sha256DigestSchema,
    status: z.enum([
      "COMPLETE",
      "SOURCE_NOT_VERIFIED",
      "OBSERVED_RUN_FAILURE",
      "INSUFFICIENT_SAMPLES",
    ]),
    reasonCodes: z.array(ReasonCodeSchema).min(1),
    sourceManifest: EmbeddedEvidenceManifestSchema,
    benchmarkArtifact: z.strictObject({ ...AgenticBenchmarkArtifactSchema.shape }).nullable(),
    acquisitionContext: AgenticBenchmarkAcquisitionContextSchema,
    limitations: z.array(z.string().min(1).max(2_048)),
    resultDigest: Sha256DigestSchema,
  })
  .meta({
    id: "https://testforge.dev/schemas/agentic-benchmark-acquisition-result.v1.json",
    title: "TestForge Agentic Benchmark acquisition result",
    description:
      "Fresh VERIFIED evidence and optional replay-valid benchmark timing evidence, sealed independently.",
  });

export const AgenticBenchmarkAcquisitionReplayResultSchema = z
  .strictObject({
    valid: z.boolean(),
    schemaValid: z.boolean(),
    sourceManifestValid: z.boolean(),
    sourceBindingValid: z.boolean(),
    artifactReplayValid: z.boolean(),
    contextBindingValid: z.boolean(),
    resultDigestValid: z.boolean(),
    statusSemanticsValid: z.boolean(),
  })
  .meta({
    id: "https://testforge.dev/schemas/agentic-benchmark-acquisition-replay-result.v1.json",
    title: "TestForge Agentic Benchmark acquisition replay result",
    description:
      "Independent source, artifact, context, digest, and status replay rails for benchmark acquisition.",
  });

const EmbeddedAgenticBenchmarkArtifactSchema = z.strictObject({
  ...AgenticBenchmarkArtifactSchema.shape,
});

export const AgenticProfileLaneV2Schema = z.strictObject({
  id: IdentifierSchema,
  maximumWarmTotalWallP95Us: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
});

export const AgenticProfileCostBasisV2Schema = z.strictObject({
  regime: z.literal("WARM"),
  measure: z.literal("WALL"),
  aggregation: z.literal("TOTAL"),
  statistic: z.literal("P95"),
  unit: z.literal("MICROSECOND"),
  portfolioAggregation: z.literal("SUM_OF_INDIVIDUAL_P95"),
});

export const AgenticProfilePolicyV2Schema = z.strictObject({
  profileVersion: z.literal("2.0.0"),
  profileId: z.string().min(1).max(256),
  mode: z.literal("HARDENING"),
  requiredComparisonScopeDigest: Sha256DigestSchema,
  costBasis: AgenticProfileCostBasisV2Schema,
  lanes: z.array(AgenticProfileLaneV2Schema).min(1).max(100),
});

export const AgenticProfileRequestV2Schema = z
  .strictObject({
    schemaVersion: z.literal("2.0.0"),
    benchmarkArtifact: EmbeddedAgenticBenchmarkArtifactSchema,
    policy: AgenticProfilePolicyV2Schema,
  })
  .meta({
    id: "https://testforge.dev/schemas/agentic-profile-request.v2.json",
    title: "TestForge Agentic Test Profile v2 request",
    description: "A replay-valid benchmark artifact and an exact warm-cost profile policy.",
  });

const AgenticProfileStatusV2Schema = z.enum([
  "QUALIFIED",
  "BUDGET_MISSED",
  "INSUFFICIENT_TIMING_EVIDENCE",
  "OBSERVED_BENCHMARK_FAILURE",
  "COMPARISON_SCOPE_MISMATCH",
]);

const AgenticProfileCandidateV2Schema = z.strictObject({
  id: IdentifierSchema,
  candidateDigest: Sha256DigestSchema,
  evidenceStatus: z.literal("ELIGIBLE"),
  classification: AgenticProfileStatusV2Schema,
  status: z.enum(["MEASURED", "INSUFFICIENT_SAMPLES", "OBSERVED_RUN_FAILURE"]),
  reasonCodes: z.array(z.string().min(1).max(256)),
  strength: z.strictObject({
    targetWeightKilled: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    totalTargetWeight: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    targetWeightPermille: z.int().min(0).max(1_000),
    requiredTargetsKilled: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    requiredTargetsTotal: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    killedTargetIds: z.array(IdentifierSchema),
  }),
  consistency: z.strictObject({
    claim: z.enum(["OBSERVED_CONSISTENT", "OBSERVED_INCONSISTENT"]),
    attempts: z.int().min(0).max(1_000),
  }),
  cost: z.strictObject({
    kind: z.literal("BENCHMARK_WARM_TOTAL_WALL_P95"),
    acceptedSamples: z.int().min(0).max(1_000),
    p95Us: z.int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  }),
  paretoStatus: z.enum(["ON_FRONTIER", "DOMINATED", "NOT_EVALUATED"]),
});

const AgenticProfilePortfolioStepV2Schema = z.strictObject({
  ordinal: z.int().min(1).max(2_000),
  candidateId: IdentifierSchema,
  marginalTargetIds: z.array(IdentifierSchema),
  marginalTargetWeight: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  candidateWarmTotalWallP95Us: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  cumulativeCostUs: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  cumulativeTargetWeight: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const AgenticProfilePortfolioV2Schema = z.strictObject({
  laneId: IdentifierSchema,
  maximumWarmTotalWallP95Us: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  costModel: z.literal("SUM_OF_INDIVIDUAL_P95"),
  selectedCandidateIds: z.array(IdentifierSchema),
  steps: z.array(AgenticProfilePortfolioStepV2Schema),
  sumIndividualWarmTotalWallP95Us: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  targetWeight: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  targetWeightPermille: z.int().min(0).max(1_000),
  requiredTargetsKilled: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  requiredTargetsTotal: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const AgenticProfileReportV2Schema = z
  .strictObject({
    schemaVersion: z.literal("2.0.0"),
    benchmarkArtifact: EmbeddedAgenticBenchmarkArtifactSchema,
    sourceBenchmarkArtifactDigest: Sha256DigestSchema,
    comparisonScopeDigest: Sha256DigestSchema,
    policy: AgenticProfilePolicyV2Schema,
    policyDigest: Sha256DigestSchema,
    status: AgenticProfileStatusV2Schema,
    candidateUniverse: z.strictObject({
      kind: z.literal("SOURCE_SELECTED_ELIGIBLE"),
      candidateIds: z.array(IdentifierSchema),
      excludedEligibleCandidateIds: z.array(IdentifierSchema),
    }),
    candidates: z.array(AgenticProfileCandidateV2Schema),
    portfolios: z.array(AgenticProfilePortfolioV2Schema),
    limitations: z.array(z.string().min(1).max(2_048)),
    reportDigest: Sha256DigestSchema,
  })
  .meta({
    id: "https://testforge.dev/schemas/agentic-profile-report.v2.json",
    title: "TestForge Agentic Test Profile v2 report",
    description:
      "A replayable strength and exact warm-cost profile over a declared benchmark cohort.",
  });

export const AgenticProfileReplayResultV2Schema = z
  .strictObject({
    valid: z.boolean(),
    schemaValid: z.boolean(),
    sourceBenchmarkValid: z.boolean(),
    sourceBindingValid: z.boolean(),
    policyDigestValid: z.boolean(),
    reportDigestValid: z.boolean(),
    semanticsValid: z.boolean(),
  })
  .meta({
    id: "https://testforge.dev/schemas/agentic-profile-replay-result.v2.json",
    title: "TestForge Agentic Test Profile v2 replay result",
    description:
      "Independent benchmark, binding, digest, and semantic replay rails for Profile v2.",
  });

const AgenticCorpusRoleSchema = z.enum(["AUTHOR", "REVIEWER"]);
const Base64UrlSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/);

export const AgenticCorpusTrustPolicySchema = z
  .strictObject({
    schemaVersion: z.literal("1.0.0"),
    policyId: IdentifierSchema,
    keys: z
      .array(
        z.strictObject({
          keyId: Sha256DigestSchema,
          subjectId: IdentifierSchema,
          roles: z.array(AgenticCorpusRoleSchema).min(1).max(2),
          publicKey: z.strictObject({
            algorithm: z.literal("Ed25519"),
            format: z.literal("SPKI_DER_BASE64URL"),
            data: Base64UrlSchema,
          }),
        }),
      )
      .min(2),
    sources: z
      .array(
        z.strictObject({
          sourceId: IdentifierSchema,
          sourceIdentityDigest: Sha256DigestSchema,
          authorizedAuthorSubjectIds: z.array(IdentifierSchema).min(1),
          authorizedReviewerSubjectIds: z.array(IdentifierSchema).min(1),
        }),
      )
      .min(1),
    policyDigest: Sha256DigestSchema,
  })
  .meta({
    id: "https://testforge.dev/schemas/agentic-corpus-trust-policy.v1.json",
    title: "TestForge agentic corpus trust policy",
    description: "An externally pinned Ed25519 trust root for agentic corpus provenance.",
  });

export const AgenticCorpusProvenanceSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0.0"),
    domain: z.literal("TESTFORGE_AGENTIC_CORPUS_CASE_V1"),
    trustPolicyDigest: Sha256DigestSchema,
    caseId: IdentifierSchema,
    caseDigest: Sha256DigestSchema,
    source: z.strictObject({
      sourceId: IdentifierSchema,
      sourceRevision: Sha256DigestSchema,
      sourceIdentityDigest: Sha256DigestSchema,
    }),
    execution: z.strictObject({
      status: z.literal("EXECUTED"),
      protocolId: IdentifierSchema,
      evidenceDigests: z.array(Sha256DigestSchema).min(1),
      receiptDigest: Sha256DigestSchema,
    }),
    author: z.strictObject({ keyId: Sha256DigestSchema, signature: Base64UrlSchema }),
    reviewer: z.strictObject({ keyId: Sha256DigestSchema, signature: Base64UrlSchema }),
    provenanceDigest: Sha256DigestSchema,
  })
  .meta({
    id: "https://testforge.dev/schemas/agentic-corpus-provenance.v1.json",
    title: "TestForge agentic corpus provenance",
    description: "Paired, dual-signed provenance for one unchanged agentic corpus case v1.",
  });

const AgenticCorpusAllocationAlgorithmSchema = z.literal("SHA256_ASCENDING_SPLIT_V1");
const AgenticCorpusAllocationPartitionSchema = z.enum(["CALIBRATION", "HOLDOUT"]);
const AgenticCorpusAllocationIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const AgenticCorpusAllocationDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const AgenticCorpusAllocationStratumRequestSchema = z.strictObject({
  sourceId: AgenticCorpusAllocationIdentifierSchema,
  sourceIdentityDigest: AgenticCorpusAllocationDigestSchema,
  calibrationCount: z.int().min(1).max(99_999),
  caseIds: z.array(AgenticCorpusAllocationIdentifierSchema).min(2).max(100_000),
});

export const AgenticCorpusAllocationRequestSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  allocationId: AgenticCorpusAllocationIdentifierSchema,
  seedDigest: AgenticCorpusAllocationDigestSchema,
  strata: z.array(AgenticCorpusAllocationStratumRequestSchema).min(1).max(100_000),
});

const AgenticCorpusAssignmentSchema = z.strictObject({
  caseId: AgenticCorpusAllocationIdentifierSchema,
  sourceId: AgenticCorpusAllocationIdentifierSchema,
  sourceIdentityDigest: AgenticCorpusAllocationDigestSchema,
  scoreDigest: AgenticCorpusAllocationDigestSchema,
  partition: AgenticCorpusAllocationPartitionSchema,
});

const AgenticCorpusAllocationStratumSchema = z.strictObject({
  sourceId: AgenticCorpusAllocationIdentifierSchema,
  sourceIdentityDigest: AgenticCorpusAllocationDigestSchema,
  calibrationCount: z.int().min(1).max(99_999),
  sourceCaseIds: z.array(AgenticCorpusAllocationIdentifierSchema).min(2).max(100_000),
  calibrationCaseIds: z.array(AgenticCorpusAllocationIdentifierSchema).min(1).max(99_999),
  holdoutCaseIds: z.array(AgenticCorpusAllocationIdentifierSchema).min(1).max(99_999),
});

export const AgenticCorpusAllocationSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  allocationId: AgenticCorpusAllocationIdentifierSchema,
  algorithm: AgenticCorpusAllocationAlgorithmSchema,
  seedDigest: AgenticCorpusAllocationDigestSchema,
  calibrationCount: z.int().min(1).max(99_999),
  sourceCaseIds: z.array(AgenticCorpusAllocationIdentifierSchema).min(2).max(100_000),
  strata: z.array(AgenticCorpusAllocationStratumSchema).min(1).max(100_000),
  calibrationCaseIds: z.array(AgenticCorpusAllocationIdentifierSchema).min(1).max(99_999),
  holdoutCaseIds: z.array(AgenticCorpusAllocationIdentifierSchema).min(1).max(99_999),
  assignments: z.array(AgenticCorpusAssignmentSchema).min(2).max(100_000),
  allocationDigest: AgenticCorpusAllocationDigestSchema,
});

export const AgenticCorpusAllocationReplayResultSchema = z.strictObject({
  valid: z.boolean(),
  schemaValid: z.boolean(),
  allocationDigestValid: z.boolean(),
  sourceCaseIdsValid: z.boolean(),
  assignmentScoresValid: z.boolean(),
  partitionSemanticsValid: z.boolean(),
});

const AgenticCorpusExperimentProtocolSchema = z.strictObject({
  protocolId: IdentifierSchema,
  protocolVersion: z.literal("1.0.0"),
  minimumStableAttempts: z.int().min(2).max(1_000),
  taxonomy: z.literal("TESTFORGE_OBSERVATION_V1"),
  detectionRule: z.literal("ATTRIBUTED_ASSERTION_FAILURE_ON_BUGGY_PASS_ON_FIXED"),
  nonEvidenceRule: z.literal("ERRORS_ARE_INSUFFICIENT_NOT_DETECTIONS"),
  maximumDetectionDeficitCases: z.int().min(0).max(100_000),
});

const AgenticCorpusCaseIdentitySchema = z.strictObject({
  caseId: IdentifierSchema,
  caseDigest: Sha256DigestSchema,
  provenanceDigest: Sha256DigestSchema,
  sourceId: IdentifierSchema,
  sourceIdentityDigest: Sha256DigestSchema,
});

const SignatureSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);
const SecretShareSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/);

const AgenticCorpusAllocationCommitmentSignerSchema = z.strictObject({
  keyId: Sha256DigestSchema,
  role: z.enum(["AUTHOR", "REVIEWER"]),
  shareCommitmentDigest: Sha256DigestSchema,
  signature: SignatureSchema,
});

export const AgenticCorpusAllocationCommitmentSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  commitmentVersion: z.literal("1.0.0"),
  commitmentId: IdentifierSchema,
  allocationId: IdentifierSchema,
  trustPolicyDigest: Sha256DigestSchema,
  caseSet: z.array(AgenticCorpusCaseIdentitySchema).min(2).max(100_000),
  strata: z
    .array(
      z.strictObject({
        sourceId: IdentifierSchema,
        sourceIdentityDigest: Sha256DigestSchema,
        calibrationCount: z.int().min(1).max(99_999),
      }),
    )
    .min(1)
    .max(100_000),
  signers: z.tuple([
    AgenticCorpusAllocationCommitmentSignerSchema,
    AgenticCorpusAllocationCommitmentSignerSchema,
  ]),
  commitmentDigest: Sha256DigestSchema,
});

export const AgenticCorpusAllocationRevealSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  revealVersion: z.literal("1.0.0"),
  commitmentDigest: Sha256DigestSchema,
  shares: z.tuple([
    z.strictObject({ keyId: Sha256DigestSchema, secret: SecretShareSchema }),
    z.strictObject({ keyId: Sha256DigestSchema, secret: SecretShareSchema }),
  ]),
  revealDigest: Sha256DigestSchema,
});

export const AgenticCorpusAllocationCommitmentReplayResultSchema = z.strictObject({
  valid: z.boolean(),
  schemaValid: z.boolean(),
  externalTrustAnchorValid: z.boolean(),
  externalCommitmentAnchorValid: z.boolean(),
  commitmentDigestValid: z.boolean(),
  caseSetValid: z.boolean(),
  commitmentSignaturesValid: z.boolean(),
  principalsDistinct: z.boolean(),
  revealValid: z.boolean(),
  finalSeedDigestValid: z.boolean(),
  allocationReplayValid: z.boolean(),
  allocationBindingValid: z.boolean(),
});

const AgenticCorpusExperimentSubjectSchema = AgenticCorpusCaseIdentitySchema.extend({
  buggyRevisionDigest: Sha256DigestSchema,
  fixedRevisionDigest: Sha256DigestSchema,
  reconstructionDigest: Sha256DigestSchema,
  requiredSuiteDigest: Sha256DigestSchema,
  qualificationReceiptDigest: Sha256DigestSchema,
});

const AgenticCorpusCandidateReferenceSchema = z.strictObject({
  candidateId: IdentifierSchema,
  candidateDigest: Sha256DigestSchema,
});

const AgenticCorpusExperimentArmSchema = z.strictObject({
  candidateUniverse: z.array(AgenticCorpusCandidateReferenceSchema).min(1).max(100_000),
  selectedCandidates: z.array(AgenticCorpusCandidateReferenceSchema).min(1).max(100_000),
  selectedSuiteDigest: Sha256DigestSchema,
});

const AgenticCorpusExperimentObservationSchema = z.strictObject({
  outcome: ObservationOutcomeSchema,
  attributed: z.boolean(),
});

const AgenticCorpusExperimentCommandSchema = z.strictObject({
  commandId: IdentifierSchema,
  adapterId: IdentifierSchema,
  arm: z.enum(["BASELINE", "PROFILE"]),
  executableIdentityDigest: Sha256DigestSchema,
  executable: z.string().min(1).max(1_024),
  arguments: z.array(z.string().max(4_096)).max(1_000),
  subjectState: z.enum(["BUGGY", "FIXED", "REQUIRED_SUITE"]),
  testSuiteDigest: Sha256DigestSchema,
  timeoutMs: z.int().min(1).max(86_400_000),
  maxStdoutBytes: z.int().min(0).max(16_777_216),
  maxStderrBytes: z.int().min(0).max(16_777_216),
});

const AgenticCorpusExperimentScheduleEntrySchema = z.strictObject({
  runId: IdentifierSchema,
  caseId: IdentifierSchema,
  arm: z.enum(["BASELINE", "PROFILE"]),
  attemptOrdinal: z.int().min(1).max(1_000),
  subjectState: z.enum(["BUGGY", "FIXED", "REQUIRED_SUITE"]),
  commandId: IdentifierSchema,
});

export const AgenticCorpusExperimentPlanSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  planVersion: z.literal("1.0.0"),
  experimentId: IdentifierSchema,
  hypothesis: z.literal("H3"),
  partition: z.literal("HOLDOUT"),
  trustPolicyDigest: Sha256DigestSchema,
  allocationCommitmentDigest: Sha256DigestSchema,
  allocationDigest: Sha256DigestSchema,
  protocol: AgenticCorpusExperimentProtocolSchema,
  subjects: z.array(AgenticCorpusExperimentSubjectSchema).min(1).max(100_000),
  adapters: z
    .array(
      z.strictObject({
        adapterId: IdentifierSchema,
        adapterVersion: z.literal("1.0.0"),
        identityDigest: Sha256DigestSchema,
        resultProtocol: z.literal("TESTFORGE_H3_STRUCTURED_RESULT_V1"),
      }),
    )
    .min(1)
    .max(1_000),
  arms: z.strictObject({
    baseline: AgenticCorpusExperimentArmSchema,
    profile: AgenticCorpusExperimentArmSchema,
  }),
  commands: z.array(AgenticCorpusExperimentCommandSchema).min(1).max(1_000_000),
  schedule: z.array(AgenticCorpusExperimentScheduleEntrySchema).min(1).max(1_000_000),
  budget: z.strictObject({
    unit: z.literal("PLANNED_PROCESS_EXECUTION"),
    baselinePlannedProcessExecutions: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
    profilePlannedProcessExecutions: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
    equalPlannedProcessExecutions: z.boolean(),
    baselinePlannedTimeoutMs: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
    profilePlannedTimeoutMs: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
    equalPlannedTimeoutBudget: z.boolean(),
  }),
  limitations: z.array(z.string().min(1).max(2_048)).min(1).max(100),
  planDigest: Sha256DigestSchema,
});

export const AgenticCorpusExperimentPlanReplayResultSchema = z.strictObject({
  valid: z.boolean(),
  schemaValid: z.boolean(),
  externalPlanAnchorValid: z.boolean(),
  planDigestValid: z.boolean(),
  allocationBindingValid: z.boolean(),
  subjectSetValid: z.boolean(),
  armsValid: z.boolean(),
  commandsValid: z.boolean(),
  scheduleValid: z.boolean(),
  budgetValid: z.boolean(),
});

export const AgenticCorpusExperimentReceiptSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  receiptVersion: z.literal("1.0.0"),
  runId: IdentifierSchema,
  planDigest: Sha256DigestSchema,
  commandId: IdentifierSchema,
  commandDigest: Sha256DigestSchema,
  caseId: IdentifierSchema,
  arm: z.enum(["BASELINE", "PROFILE"]),
  attemptOrdinal: z.int().min(1).max(1_000),
  subjectState: z.enum(["BUGGY", "FIXED", "REQUIRED_SUITE"]),
  repositoryDigest: Sha256DigestSchema,
  testSuiteDigest: Sha256DigestSchema,
  appliedTimeoutMs: z.int().min(1).max(86_400_000),
  process: z.strictObject({
    exitCode: z.int().min(0).max(255).nullable(),
    timedOut: z.boolean(),
    stdoutDigest: Sha256DigestSchema,
    stderrDigest: Sha256DigestSchema,
  }),
  structuredResultDigest: Sha256DigestSchema,
  receiptDigest: Sha256DigestSchema,
});

export const AgenticCorpusExperimentStructuredResultSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  protocol: z.literal("TESTFORGE_H3_STRUCTURED_RESULT_V1"),
  outcome: ObservationOutcomeSchema,
  attributed: z.boolean(),
});

const AgenticCorpusExperimentAttemptSchema = z.strictObject({
  ordinal: z.int().min(1).max(1_000),
  buggy: AgenticCorpusExperimentObservationSchema,
  fixed: AgenticCorpusExperimentObservationSchema,
  requiredSuite: AgenticCorpusExperimentObservationSchema,
  runIds: z.strictObject({
    buggy: IdentifierSchema,
    fixed: IdentifierSchema,
    requiredSuite: IdentifierSchema,
  }),
});

const AgenticCorpusExperimentPayloadSchema = z.strictObject({
  cases: z
    .array(
      z.strictObject({
        caseId: IdentifierSchema,
        baselineAttempts: z.array(AgenticCorpusExperimentAttemptSchema).min(1).max(1_000),
        profileAttempts: z.array(AgenticCorpusExperimentAttemptSchema).min(1).max(1_000),
      }),
    )
    .min(1)
    .max(100_000),
});

const AgenticCorpusExperimentResultSchema = z.strictObject({
  status: z.enum(["SUPPORTED", "NOT_SUPPORTED", "INSUFFICIENT"]),
  evaluatedCaseIds: z.array(IdentifierSchema).min(1),
  baselineDetectedCaseIds: z.array(IdentifierSchema),
  profileDetectedCaseIds: z.array(IdentifierSchema),
  insufficientCaseIds: z.array(IdentifierSchema),
  baselineDetectedCount: z.int().min(0),
  profileDetectedCount: z.int().min(0),
  maximumDetectionDeficitCases: z.int().min(0),
  nonInferior: z.boolean(),
  sourceResults: z.array(
    z.strictObject({
      sourceId: IdentifierSchema,
      sourceIdentityDigest: Sha256DigestSchema,
      evaluatedCaseIds: z.array(IdentifierSchema).min(1),
      baselineDetectedCount: z.int().min(0),
      profileDetectedCount: z.int().min(0),
      nonInferior: z.boolean(),
    }),
  ),
});

export const AgenticCorpusExperimentRequestSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  experimentVersion: z.literal("1.0.0"),
  experimentId: IdentifierSchema,
  hypothesis: z.literal("H3"),
  partition: z.literal("HOLDOUT"),
  planDigest: Sha256DigestSchema,
  allocationDigest: Sha256DigestSchema,
  trustPolicyDigest: Sha256DigestSchema,
  evidenceBindings: z
    .array(
      z.strictObject({
        runId: IdentifierSchema,
        receiptDigest: Sha256DigestSchema,
        receiptContentDigest: Sha256DigestSchema,
      }),
    )
    .min(1)
    .max(1_000_000),
  payloadSchemaId: z.literal("https://testforge.dev/payloads/agentic-corpus-experiment-h3.v1.json"),
  payload: AgenticCorpusExperimentPayloadSchema,
  limitations: z.array(z.string().min(1).max(2_048)).min(1).max(100),
});

export const AgenticCorpusExperimentArtifactSchema = AgenticCorpusExperimentRequestSchema.extend({
  candidateSetDigest: Sha256DigestSchema,
  evidenceSetDigest: Sha256DigestSchema,
  payloadDigest: Sha256DigestSchema,
  result: AgenticCorpusExperimentResultSchema,
  artifactDigest: Sha256DigestSchema,
});

export const AgenticCorpusExperimentReplayRequestSchema = z.strictObject({
  artifact: AgenticCorpusExperimentArtifactSchema,
});

export const AgenticCorpusExperimentReplayResultSchema = z.strictObject({
  valid: z.boolean(),
  schemaValid: z.boolean(),
  artifactDigestValid: z.boolean(),
  externalTrustAnchorValid: z.boolean(),
  externalCommitmentAnchorValid: z.boolean(),
  commitmentRevealValid: z.boolean(),
  allocationReplayValid: z.boolean(),
  allocationBindingValid: z.boolean(),
  externalPlanAnchorValid: z.boolean(),
  planDigestValid: z.boolean(),
  planSemanticsValid: z.boolean(),
  subjectDigestsValid: z.boolean(),
  provenanceReplayValid: z.boolean(),
  scheduleValid: z.boolean(),
  budgetValid: z.boolean(),
  evidenceSetDigestValid: z.boolean(),
  receiptBindingsValid: z.boolean(),
  candidateEvidenceValid: z.boolean(),
  outputBytesResolved: z.boolean(),
  structuredResultsValid: z.boolean(),
  payloadSupported: z.boolean(),
  payloadDigestValid: z.boolean(),
  observationSemanticsValid: z.boolean(),
  resultSemanticsValid: z.boolean(),
});

export type ObservationOutcome = z.infer<typeof ObservationOutcomeSchema>;
export type FileOverlay = z.infer<typeof FileOverlaySchema>;
export type World = z.infer<typeof WorldSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type VerificationRequest = z.infer<typeof VerificationRequestSchema>;
export type NodeTestAdapter = z.infer<typeof NodeTestAdapterSchema>;
export type StructuredCommandAdapter = z.infer<typeof StructuredCommandAdapterSchema>;
export type RepositoryAnalysis = z.infer<typeof RepositoryAnalysisSchema>;
export type RepositoryAudit = z.infer<typeof RepositoryAuditSchema>;
export type RepositoryInitConfig = z.infer<typeof RepositoryInitConfigSchema>;
export type RepositoryInitLock = z.infer<typeof RepositoryInitLockSchema>;
export type RepositoryInitResult = z.infer<typeof RepositoryInitResultSchema>;
export type RepositoryInitDetections = z.infer<typeof RepositoryInitDetectionsSchema>;
export type EvidenceManifestContract = z.infer<typeof EvidenceManifestSchema>;
export type ReplayResult = z.infer<typeof ReplayResultSchema>;
export type AgenticProfilePolicy = z.infer<typeof AgenticProfilePolicySchema>;
export type AgenticProfileRequest = z.infer<typeof AgenticProfileRequestSchema>;
export type AgenticProfileReport = z.infer<typeof AgenticProfileReportSchema>;
export type AgenticProfileReplayResult = z.infer<typeof AgenticProfileReplayResultSchema>;
export type AgenticBenchmarkPolicy = z.infer<typeof AgenticBenchmarkPolicySchema>;
export type AgenticBenchmarkProtocol = z.infer<typeof AgenticBenchmarkProtocolSchema>;
export type AgenticBenchmarkFingerprint = z.infer<typeof AgenticBenchmarkFingerprintSchema>;
export type AgenticBenchmarkRun = z.infer<typeof AgenticBenchmarkRunSchema>;
export type AgenticBenchmarkRequest = z.infer<typeof AgenticBenchmarkRequestSchema>;
export type AgenticBenchmarkArtifact = z.infer<typeof AgenticBenchmarkArtifactSchema>;
export type AgenticBenchmarkReplayResult = z.infer<typeof AgenticBenchmarkReplayResultSchema>;
export type AgenticBenchmarkAcquisitionRequest = z.infer<
  typeof AgenticBenchmarkAcquisitionRequestSchema
>;
export type AgenticBenchmarkAcquisitionResult = z.infer<
  typeof AgenticBenchmarkAcquisitionResultSchema
>;
export type AgenticBenchmarkAcquisitionReplayResult = z.infer<
  typeof AgenticBenchmarkAcquisitionReplayResultSchema
>;
export type AgenticProfilePolicyV2 = z.infer<typeof AgenticProfilePolicyV2Schema>;
export type AgenticProfileRequestV2 = z.infer<typeof AgenticProfileRequestV2Schema>;
export type AgenticProfileReportV2 = z.infer<typeof AgenticProfileReportV2Schema>;
export type AgenticProfileReplayResultV2 = z.infer<typeof AgenticProfileReplayResultV2Schema>;
export type AgenticCorpusTrustPolicy = z.infer<typeof AgenticCorpusTrustPolicySchema>;
export type AgenticCorpusProvenance = z.infer<typeof AgenticCorpusProvenanceSchema>;
export type AgenticCorpusAllocationRequest = z.infer<typeof AgenticCorpusAllocationRequestSchema>;
export type AgenticCorpusAllocation = z.infer<typeof AgenticCorpusAllocationSchema>;
export type AgenticCorpusAllocationReplayResult = z.infer<
  typeof AgenticCorpusAllocationReplayResultSchema
>;
export type AgenticCorpusAllocationCommitment = z.infer<
  typeof AgenticCorpusAllocationCommitmentSchema
>;
export type AgenticCorpusAllocationReveal = z.infer<typeof AgenticCorpusAllocationRevealSchema>;
export type AgenticCorpusAllocationCommitmentReplayResult = z.infer<
  typeof AgenticCorpusAllocationCommitmentReplayResultSchema
>;
export type AgenticCorpusExperimentPlan = z.infer<typeof AgenticCorpusExperimentPlanSchema>;
export type AgenticCorpusExperimentPlanReplayResult = z.infer<
  typeof AgenticCorpusExperimentPlanReplayResultSchema
>;
export type AgenticCorpusExperimentRequest = z.infer<typeof AgenticCorpusExperimentRequestSchema>;
export type AgenticCorpusExperimentArtifact = z.infer<typeof AgenticCorpusExperimentArtifactSchema>;
export type AgenticCorpusExperimentReplayRequest = z.infer<
  typeof AgenticCorpusExperimentReplayRequestSchema
>;
export type AgenticCorpusExperimentReplayResult = z.infer<
  typeof AgenticCorpusExperimentReplayResultSchema
>;
export type AgenticCorpusExperimentReceipt = z.infer<typeof AgenticCorpusExperimentReceiptSchema>;
export type AgenticCorpusExperimentStructuredResult = z.infer<
  typeof AgenticCorpusExperimentStructuredResultSchema
>;

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

function repositoryAuditPortableKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function compareRepositoryAuditPaths(left: string, right: string): number {
  const leftKey = repositoryAuditPortableKey(left);
  const rightKey = repositoryAuditPortableKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function repositoryAuditModulePrefix(file: string): string {
  const segments = file.split("/");
  return segments.length > 2 ? segments.slice(0, 2).join("/") : (segments[0] ?? file);
}

function expectedRepositoryAuditModules(
  files: RepositoryAudit["files"],
): RepositoryAudit["modules"] {
  const grouped = new Map<string, RepositoryAudit["files"]>();
  for (const file of files) {
    const prefix = repositoryAuditModulePrefix(file.path);
    grouped.set(prefix, [...(grouped.get(prefix) ?? []), file]);
  }
  return [...grouped]
    .map(([pathPrefix, members]) => ({
      pathPrefix,
      files: members.length,
      factualTuple: [
        members.reduce((sum, file) => sum + (file.decisionPoints ?? 0), 0),
        members.reduce((sum, file) => sum + (file.noObservedTestReference?.length ?? 0), 0),
        members.reduce((sum, file) => sum + (file.fixCommitsInWindow ?? 0), 0),
        members.reduce((sum, file) => sum + (file.commitsInWindow ?? 0), 0),
        members.filter((file) => file.sourceChangedAfterAssociatedTest === true).length,
        members.reduce(
          (sum, file) =>
            sum + (file.weakAssertions ?? []).reduce((inner, item) => inner + item.count, 0),
          0,
        ),
      ] as [number, number, number, number, number, number],
    }))
    .sort((left, right) => {
      for (let index = 0; index < left.factualTuple.length; index += 1) {
        const delta = (right.factualTuple[index] ?? 0) - (left.factualTuple[index] ?? 0);
        if (delta !== 0) return delta;
      }
      return compareRepositoryAuditPaths(left.pathPrefix, right.pathPrefix);
    })
    .map((module, index) => ({ ...module, rank: index + 1 }));
}

function expectedRepositoryAuditCost(audit: RepositoryAudit): RepositoryAudit["cost"] {
  const request = audit.verificationRequest;
  const candidates = request?.candidates.length ?? 0;
  const worlds = request?.worlds.length ?? 0;
  const attempts = request?.policy.requiredAttempts ?? 0;
  const C = BigInt(candidates);
  const W = BigInt(worlds);
  const A = BigInt(attempts);
  const executions = (C + 1n) * W * A;
  const worldBytes = BigInt(
    request?.worlds.reduce(
      (sum, world) =>
        sum + world.files.reduce((fileSum, file) => fileSum + Buffer.byteLength(file.content), 0),
      0,
    ) ?? 0,
  );
  const candidateBytes = BigInt(
    request?.candidates.reduce(
      (sum, candidate) =>
        sum +
        candidate.files.reduce((fileSum, file) => fileSum + Buffer.byteLength(file.content), 0),
      0,
    ) ?? 0,
  );
  const overlayBytes = A * ((C + 1n) * worldBytes + W * candidateBytes);
  return {
    candidates,
    worlds,
    attempts,
    executions: executions.toString(),
    controlExecutions: (W * A).toString(),
    candidateExecutions: (C * W * A).toString(),
    overlayBytes: overlayBytes.toString(),
    materializationBytes: (
      BigInt(audit.repositoryBytes) * (executions + 1n) +
      overlayBytes
    ).toString(),
    timeoutLimitMs: (executions * BigInt(request?.budgets.timeoutMsPerExecution ?? 0)).toString(),
    capturedStreamLimitBytes: (
      executions *
      BigInt(request?.budgets.maximumOutputBytes ?? 0) *
      2n
    ).toString(),
  };
}

export function parseRepositoryAudit(value: unknown): RepositoryAudit {
  const parsed = RepositoryAuditSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("REPOSITORY_AUDIT_INVALID", z.prettifyError(parsed.error));
  }
  if (parsed.data.modules.some((module, index) => module.rank !== index + 1)) {
    throw new ContractError("REPOSITORY_AUDIT_RANKS_INVALID");
  }
  const audit = parsed.data;
  if (
    audit.fileCount !== audit.files.length ||
    audit.repositoryBytes !== audit.files.reduce((sum, file) => sum + file.bytes, 0)
  ) {
    throw new ContractError("REPOSITORY_AUDIT_INVENTORY_INCONSISTENT");
  }
  const fileKeys = audit.files.map((file) => repositoryAuditPortableKey(file.path));
  if (
    new Set(fileKeys).size !== fileKeys.length ||
    fileKeys.some((key, index) => index > 0 && (fileKeys[index - 1] ?? "") >= key)
  ) {
    throw new ContractError("REPOSITORY_AUDIT_FILES_INVALID");
  }
  for (const file of audit.files) {
    const arrays = [file.declaredExports, file.noObservedTestReference, file.associatedTests];
    const weakCategories = file.weakAssertions?.map((item) => item.category) ?? [];
    if (
      arrays.some(
        (items) =>
          items !== null &&
          (new Set(items).size !== items.length ||
            items.some((item, index) => index > 0 && (items[index - 1] ?? "") >= item)),
      ) ||
      (file.declaredExports !== null &&
        file.noObservedTestReference?.some((name) => !file.declaredExports?.includes(name))) ||
      (file.supported
        ? file.decisionPoints === null ||
          file.declaredExports === null ||
          file.noObservedTestReference === null ||
          file.weakAssertions === null
        : file.decisionPoints !== null ||
          file.declaredExports !== null ||
          file.noObservedTestReference !== null ||
          file.weakAssertions !== null) ||
      (file.commitsInWindow === null) !== (file.fixCommitsInWindow === null) ||
      (file.commitsInWindow !== null &&
        file.fixCommitsInWindow !== null &&
        file.fixCommitsInWindow > file.commitsInWindow) ||
      new Set(weakCategories).size !== weakCategories.length ||
      weakCategories.some(
        (category, index) => index > 0 && (weakCategories[index - 1] ?? "") >= category,
      )
    ) {
      throw new ContractError("REPOSITORY_AUDIT_FILE_FACTS_INVALID");
    }
  }
  const gitReasonCodes = new Set(audit.reasonCodes);
  const fatalGitReasonCodes = [
    "GIT_DISABLED",
    "GIT_UNAVAILABLE",
    "GIT_HEAD_UNAVAILABLE",
    "GIT_INDEX_UNAVAILABLE",
    "GIT_HISTORY_UNAVAILABLE",
    "GIT_HISTORY_SHALLOW",
    "GIT_HISTORY_TRUNCATED",
  ];
  const gitReasonSemanticsValid = audit.git.supported
    ? !fatalGitReasonCodes.some((code) => gitReasonCodes.has(code))
    : audit.git.headTimestamp === null
      ? audit.git.shallow === null &&
        audit.git.truncated === null &&
        ["GIT_DISABLED", "GIT_UNAVAILABLE", "GIT_HEAD_UNAVAILABLE"].some((code) =>
          gitReasonCodes.has(code),
        )
      : audit.git.shallow === true
        ? gitReasonCodes.has("GIT_HISTORY_SHALLOW") && audit.git.truncated === null
        : audit.git.truncated === true
          ? gitReasonCodes.has("GIT_HISTORY_TRUNCATED") && audit.git.shallow === false
          : ["GIT_INDEX_UNAVAILABLE", "GIT_HISTORY_UNAVAILABLE"].some((code) =>
              gitReasonCodes.has(code),
            );
  if (
    audit.reasonCodes.some(
      (code, index) => index > 0 && (audit.reasonCodes[index - 1] ?? "") >= code,
    ) ||
    (audit.git.supported &&
      (audit.git.headTimestamp === null ||
        audit.git.shallow !== false ||
        audit.git.truncated !== false)) ||
    !gitReasonSemanticsValid ||
    ((!audit.git.supported || audit.git.shallow === true || audit.git.truncated === true) &&
      audit.files.some(
        (file) =>
          file.commitsInWindow !== null ||
          file.fixCommitsInWindow !== null ||
          file.sourceChangedAfterAssociatedTest !== null,
      ))
  ) {
    throw new ContractError("REPOSITORY_AUDIT_GIT_FACTS_INVALID");
  }
  const expectedModules = expectedRepositoryAuditModules(audit.files);
  if (
    audit.modules.length !== expectedModules.length ||
    audit.modules.some((module, index) => {
      const expected = expectedModules[index];
      return (
        expected === undefined ||
        module.pathPrefix !== expected.pathPrefix ||
        module.rank !== expected.rank ||
        module.files !== expected.files ||
        module.factualTuple.some((value, tupleIndex) => value !== expected.factualTuple[tupleIndex])
      );
    })
  ) {
    throw new ContractError("REPOSITORY_AUDIT_MODULES_INCONSISTENT");
  }
  if (
    !path.isAbsolute(audit.root) ||
    path.normalize(audit.root) !== audit.root ||
    JSON.stringify(audit.cost) !== JSON.stringify(expectedRepositoryAuditCost(audit)) ||
    (audit.verificationRequest === null) !==
      audit.reasonCodes.includes("VERIFICATION_REQUEST_UNAVAILABLE") ||
    audit.verificationRequest?.isolation.acknowledgedUnsafeExecution === true ||
    (audit.verificationRequest !== null && audit.verificationRequest.repository.root !== audit.root)
  ) {
    throw new ContractError("REPOSITORY_AUDIT_VERIFICATION_INCONSISTENT");
  }
  return audit;
}

function initCanonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ContractError("REPOSITORY_INIT_CANONICAL_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(initCanonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${initCanonicalize(record[key])}`)
      .join(",")}}`;
  }
  throw new ContractError("REPOSITORY_INIT_CANONICAL_INVALID");
}

function initDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(initCanonicalize(value)).digest("hex")}`;
}

function initBytesDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function initPortablePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    /^(?:[a-zA-Z]:|[/]{1,2})/u.test(value) ||
    value.includes(":") ||
    path.posix.normalize(value) !== value
  ) {
    return false;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }
  return segments.every((segment) => {
    const hasControl = [...segment].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    });
    return (
      segment.normalize("NFC") === segment &&
      !hasControl &&
      !/[<>"|?*]/u.test(segment) &&
      !/[. ]$/u.test(segment) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)
    );
  });
}

function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function initPortableKey(value: string): string {
  return value.toLowerCase().normalize("NFC");
}

function validateInitDetections(detections: RepositoryInitDetections, code: string): void {
  if (
    !sortedUnique(detections.ciProviders) ||
    !sortedUnique(detections.reasonCodes) ||
    (detections.testCommand !== null && !initCommandSafe(detections.testCommand))
  ) {
    throw new ContractError(code);
  }
}

function initCommandSafe(command: { executable: string; arguments: readonly string[] }): boolean {
  const absoluteLike = (value: string): boolean =>
    /^(?:[a-zA-Z]:|[\\/]{1,2})/u.test(value) || path.isAbsolute(value);
  return (
    command.executable.length > 0 &&
    !absoluteLike(command.executable) &&
    !/[\s;&|<>`]/u.test(command.executable) &&
    ![...command.executable].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    }) &&
    command.arguments.every(
      (argument) =>
        !absoluteLike(argument) &&
        ![...argument].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
        }),
    )
  );
}

function expectedInitEvidenceKind(
  evidencePath: string,
): RepositoryInitLock["evidence"][number]["kind"] | undefined {
  if (
    evidencePath === "package.json" ||
    evidencePath === "pyproject.toml" ||
    evidencePath === "requirements.txt"
  ) {
    return "PACKAGE_MANIFEST";
  }
  if (
    [
      "pnpm-lock.yaml",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      "uv.lock",
      "poetry.lock",
      "Pipfile.lock",
    ].includes(evidencePath)
  ) {
    return "LOCKFILE";
  }
  if (
    evidencePath.startsWith(".github/workflows/") ||
    evidencePath === ".gitlab-ci.yml" ||
    evidencePath === "azure-pipelines.yml" ||
    evidencePath === ".circleci/config.yml"
  ) {
    return "CI_CONFIG";
  }
  if (/((^|\/)test[^/]*|\.test|\.spec)\.(?:[cm]?[jt]s|tsx?|py)$/u.test(evidencePath)) {
    return "TEST_SOURCE";
  }
  return undefined;
}

export function parseRepositoryInitConfig(value: unknown): RepositoryInitConfig {
  const parsed = RepositoryInitConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("REPOSITORY_INIT_CONFIG_INVALID", z.prettifyError(parsed.error));
  }
  const config = parsed.data;
  const candidateRootKeys = config.candidateRoots.map(initPortableKey);
  const baseTestFiles = config.adapter.kind === "node-test" ? config.adapter.baseTestFiles : [];
  const baseTestKeys = baseTestFiles.map(initPortableKey);
  if (
    !sortedUnique(config.repository.exclude) ||
    !sortedUnique(config.candidateRoots) ||
    [...config.repository.exclude, ...config.candidateRoots].some(
      (entry) => !initPortablePath(entry),
    ) ||
    !initCommandSafe(config.testCommand) ||
    !initCommandSafe({
      executable: config.adapter.executable,
      arguments: config.adapter.kind === "testforge-command" ? config.adapter.arguments : [],
    }) ||
    (config.adapter.kind === "node-test" && config.framework !== "node:test") ||
    !sortedUnique(baseTestKeys) ||
    baseTestFiles.some((entry) => expectedInitEvidenceKind(entry) !== "TEST_SOURCE") ||
    baseTestKeys.some((baseTestKey) =>
      candidateRootKeys.some(
        (candidateRootKey) =>
          baseTestKey === candidateRootKey || baseTestKey.startsWith(`${candidateRootKey}/`),
      ),
    ) ||
    (config.adapter.kind === "node-test" &&
      config.adapter.baseTestFiles.some((entry) => !initPortablePath(entry))) ||
    (config.adapter.kind === "testforge-command" &&
      config.adapter.arguments.some((argument) => path.isAbsolute(argument)))
  ) {
    throw new ContractError("REPOSITORY_INIT_CONFIG_INCONSISTENT");
  }
  return config;
}

export function repositoryInitConfigDigest(config: RepositoryInitConfig): string {
  return initDigest(parseRepositoryInitConfig(config));
}

export function repositoryInitLockDigest(lock: Omit<RepositoryInitLock, "lockDigest">): string {
  return initDigest(lock);
}

export function parseRepositoryInitLock(value: unknown): RepositoryInitLock {
  const parsed = RepositoryInitLockSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("REPOSITORY_INIT_LOCK_INVALID", z.prettifyError(parsed.error));
  }
  const lock = parsed.data;
  const adapterEvidenceCount = lock.evidence.filter(
    (entry) => entry.kind === "ADAPTER_CONFIG",
  ).length;
  validateInitDetections(lock.detections, "REPOSITORY_INIT_LOCK_INCONSISTENT");
  if (
    lock.detections.packageManager === null ||
    lock.detections.framework === null ||
    lock.detections.testCommand === null ||
    lock.detections.adapterRecommendation === "unavailable" ||
    (lock.detections.adapterRecommendation === "node-test" && adapterEvidenceCount !== 0) ||
    (lock.detections.adapterRecommendation === "operator-supplied" && adapterEvidenceCount !== 1) ||
    !sortedUnique(lock.evidence.map((entry) => entry.path)) ||
    lock.evidence.some((entry) => {
      if (!initPortablePath(entry.path)) return true;
      const expectedKind = expectedInitEvidenceKind(entry.path);
      return entry.kind === "ADAPTER_CONFIG"
        ? expectedKind !== undefined
        : expectedKind !== entry.kind;
    }) ||
    lock.lockDigest !==
      repositoryInitLockDigest({
        schemaVersion: lock.schemaVersion,
        configDigest: lock.configDigest,
        detector: lock.detector,
        evidence: lock.evidence,
        detections: lock.detections,
      })
  ) {
    throw new ContractError("REPOSITORY_INIT_LOCK_INCONSISTENT");
  }
  return lock;
}

export function parseRepositoryInitResult(value: unknown): RepositoryInitResult {
  const parsed = RepositoryInitResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("REPOSITORY_INIT_RESULT_INVALID", z.prettifyError(parsed.error));
  }
  const result = parsed.data;
  validateInitDetections(result.detections, "REPOSITORY_INIT_RESULT_INCONSISTENT");
  const paths = result.files.map((file) => file.path);
  const actionPaths = result.actions.map((action) => action.path);
  const successWithPlan = ["CREATED", "WOULD_CREATE"].includes(result.status);
  let config: RepositoryInitConfig | undefined;
  let lock: RepositoryInitLock | undefined;
  try {
    const configFile = result.files.find((file) => file.path === "assertledger.config.json");
    const lockFile = result.files.find((file) => file.path === "assertledger.lock.json");
    if (configFile !== undefined)
      config = parseRepositoryInitConfig(JSON.parse(configFile.content));
    if (lockFile !== undefined) lock = parseRepositoryInitLock(JSON.parse(lockFile.content));
  } catch (error) {
    throw new ContractError(
      "REPOSITORY_INIT_RESULT_INCONSISTENT",
      error instanceof Error ? error.message : String(error),
    );
  }
  const nodeBaseTestFiles =
    config?.adapter.kind === "node-test" ? config.adapter.baseTestFiles : [];
  const lockTestEvidence = new Set(
    lock?.evidence
      .filter((entry) => entry.kind === "TEST_SOURCE")
      .map((entry) => initPortableKey(entry.path)) ?? [],
  );
  if (
    !sortedUnique(result.reasonCodes) ||
    !sortedUnique(paths) ||
    !sortedUnique(actionPaths) ||
    result.actions.some((action) => !paths.includes(action.path)) ||
    JSON.stringify(result.reasonCodes) !== JSON.stringify(result.detections.reasonCodes) ||
    result.files.some(
      (file) =>
        file.digest !== initBytesDigest(file.content) ||
        !file.content.endsWith("\n") ||
        `${initCanonicalize(JSON.parse(file.content))}\n` !== file.content,
    ) ||
    (successWithPlan && (result.files.length !== 2 || result.actions.length === 0)) ||
    result.actions.some(
      (action) =>
        (action.path === "assertledger.config.json" && action.kind !== "CREATE") ||
        (action.kind === "REGENERATE" && action.path !== "assertledger.lock.json"),
    ) ||
    (["BLOCKED", "CONFLICT", "UNCHANGED"].includes(result.status) && result.actions.length !== 0) ||
    (["BLOCKED", "CONFLICT"].includes(result.status) && result.files.length !== 0) ||
    (result.status === "UNCHANGED" && result.files.length !== 2) ||
    (config !== undefined &&
      (lock === undefined ||
        lock.configDigest !== repositoryInitConfigDigest(config) ||
        lock.detections.packageManager !== config.packageManager ||
        lock.detections.framework !== config.framework ||
        JSON.stringify(lock.detections.testCommand) !== JSON.stringify(config.testCommand) ||
        JSON.stringify(lock.detections) !== JSON.stringify(result.detections) ||
        nodeBaseTestFiles.some((file) => !lockTestEvidence.has(initPortableKey(file))))) ||
    result.nextCommands.length !== 1 ||
    result.nextCommands[0]?.executable !== "assertledger" ||
    JSON.stringify(result.nextCommands[0]?.arguments) !== JSON.stringify(["audit", ".", "--json"])
  ) {
    throw new ContractError("REPOSITORY_INIT_RESULT_INCONSISTENT");
  }
  return result;
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

function validateAgenticProfilePolicy(policy: AgenticProfilePolicy): void {
  const laneIds = new Set<string>();
  let previousMaximum = 0;
  for (const lane of policy.lanes) {
    if (laneIds.has(lane.id) || lane.maximumReferenceP95Ms <= previousMaximum) {
      throw new ContractError("AGENTIC_PROFILE_POLICY_INVALID");
    }
    laneIds.add(lane.id);
    previousMaximum = lane.maximumReferenceP95Ms;
  }
}

export function parseAgenticProfileRequest(value: unknown): AgenticProfileRequest {
  const parsed = AgenticProfileRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("AGENTIC_PROFILE_REQUEST_INVALID", z.prettifyError(parsed.error));
  }
  const request = parsed.data;
  parseEvidenceManifest(request.manifest);
  validateAgenticProfilePolicy(request.policy);
  return request;
}

export function parseAgenticProfileReport(value: unknown): AgenticProfileReport {
  const parsed = AgenticProfileReportSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("AGENTIC_PROFILE_REPORT_INVALID", z.prettifyError(parsed.error));
  }
  const report = parsed.data;
  parseEvidenceManifest(report.sourceManifest);
  validateAgenticProfilePolicy(report.policy);
  const candidateIds = new Set(report.candidates.map((candidate) => candidate.id));
  if (
    candidateIds.size !== report.candidates.length ||
    report.qualifiedCandidateIds.some((id) => !candidateIds.has(id))
  ) {
    throw new ContractError("AGENTIC_PROFILE_REPORT_INCONSISTENT");
  }
  return report;
}

export function parseAgenticProfileReplayResult(value: unknown): AgenticProfileReplayResult {
  const parsed = AgenticProfileReplayResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("AGENTIC_PROFILE_REPLAY_RESULT_INVALID", z.prettifyError(parsed.error));
  }
  const result = parsed.data;
  if (
    result.valid !==
    (result.schemaValid &&
      result.sourceManifestValid &&
      result.policyDigestValid &&
      result.reportDigestValid &&
      result.semanticsValid)
  ) {
    throw new ContractError("AGENTIC_PROFILE_REPLAY_RESULT_INCONSISTENT");
  }
  return result;
}

function validateAgenticBenchmarkInputs(request: AgenticBenchmarkRequest): void {
  parseEvidenceManifest(request.sourceManifest);
  const { policy } = request;
  const selectedCandidates = request.sourceManifest.decision.selectedCandidateIds.map((id) =>
    request.sourceManifest.candidates.find((candidate) => candidate.id === id),
  );
  if (selectedCandidates.some((candidate) => candidate === undefined)) {
    throw new ContractError("AGENTIC_BENCHMARK_SOURCE_BINDING_INVALID");
  }
  const plannedPerCandidate =
    policy.coldMeasuredSamples + policy.warmupSamples + policy.warmMeasuredSamples;
  if (selectedCandidates.length * plannedPerCandidate > policy.maximumExecutions) {
    throw new ContractError("AGENTIC_BENCHMARK_EXECUTION_BUDGET_EXCEEDED");
  }

  const toolRoles = new Set<string>();
  for (const tool of request.fingerprint.tools) {
    if (toolRoles.has(tool.role)) {
      throw new ContractError("AGENTIC_BENCHMARK_DUPLICATE_TOOL_ROLE", tool.role);
    }
    toolRoles.add(tool.role);
  }

  const expectedPhaseNames = [
    "PREPARATION",
    "STARTUP",
    "COMPILE_OR_COLLECTION",
    "EXECUTION",
  ] as const;
  const groups = new Map<string, number[]>();
  for (const run of request.runs) {
    if (run.regime === "COLD" && run.role === "WARMUP") {
      throw new ContractError("AGENTIC_BENCHMARK_COLD_WARMUP_FORBIDDEN");
    }
    if (run.status === "COMPLETE") {
      const phaseTotalUs = run.phases.reduce((total, phase) => total + phase.durationUs, 0);
      if (
        run.phases.some((phase, index) => phase.phase !== expectedPhaseNames[index]) ||
        !Number.isSafeInteger(phaseTotalUs) ||
        run.totalUs !== phaseTotalUs
      ) {
        throw new ContractError("AGENTIC_BENCHMARK_TIMING_INVALID");
      }
    }
    const key = `${run.candidateId}\u0000${run.regime}\u0000${run.role}`;
    const ordinals = groups.get(key) ?? [];
    ordinals.push(run.ordinal);
    groups.set(key, ordinals);
  }
  for (const ordinals of groups.values()) {
    ordinals.sort((left, right) => left - right);
    if (ordinals.some((ordinal, index) => ordinal !== index + 1)) {
      throw new ContractError("AGENTIC_BENCHMARK_ORDINALS_INVALID");
    }
  }

  const selectedById = new Map(
    selectedCandidates.map((candidate) => [candidate?.id as string, candidate]),
  );
  for (const run of request.runs) {
    const candidate = selectedById.get(run.candidateId);
    if (candidate === undefined || candidate.status !== "ELIGIBLE") {
      throw new ContractError("AGENTIC_BENCHMARK_SUBJECT_INVALID", run.candidateId);
    }
    if (run.candidateDigest !== candidate.digest) {
      throw new ContractError("AGENTIC_BENCHMARK_CANDIDATE_DIGEST_MISMATCH", run.candidateId);
    }
  }
  for (const candidate of selectedCandidates) {
    if (candidate === undefined || candidate.status !== "ELIGIBLE") {
      throw new ContractError("AGENTIC_BENCHMARK_SUBJECT_INVALID");
    }
    const counts = { cold: 0, warmup: 0, warm: 0 };
    for (const run of request.runs) {
      if (run.candidateId !== candidate.id) continue;
      if (run.regime === "COLD") counts.cold += 1;
      else if (run.role === "WARMUP") counts.warmup += 1;
      else counts.warm += 1;
    }
    if (
      counts.cold !== policy.coldMeasuredSamples ||
      counts.warmup !== policy.warmupSamples ||
      counts.warm !== policy.warmMeasuredSamples
    ) {
      throw new ContractError("AGENTIC_BENCHMARK_RUN_PLAN_INVALID", candidate.id);
    }
  }
}

export function parseAgenticBenchmarkRequest(value: unknown): AgenticBenchmarkRequest {
  const parsed = AgenticBenchmarkRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("AGENTIC_BENCHMARK_REQUEST_INVALID", z.prettifyError(parsed.error));
  }
  validateAgenticBenchmarkInputs(parsed.data);
  return parsed.data;
}

export function parseAgenticBenchmarkArtifact(value: unknown): AgenticBenchmarkArtifact {
  const parsed = AgenticBenchmarkArtifactSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("AGENTIC_BENCHMARK_ARTIFACT_INVALID", z.prettifyError(parsed.error));
  }
  const artifact = parsed.data;
  validateAgenticBenchmarkInputs({
    schemaVersion: artifact.schemaVersion,
    sourceManifest: artifact.sourceManifest,
    referenceWorldId: artifact.referenceWorldId,
    policy: artifact.policy,
    protocol: artifact.protocol,
    fingerprint: artifact.fingerprint,
    runs: artifact.runs,
  });
  const summaryKeys = new Set<string>();
  for (const summary of artifact.summaries) {
    const key = `${summary.candidateId}\u0000${summary.regime}`;
    if (summaryKeys.has(key)) {
      throw new ContractError("AGENTIC_BENCHMARK_SUMMARY_DUPLICATE");
    }
    summaryKeys.add(key);
  }
  return artifact;
}

export function parseAgenticBenchmarkReplayResult(value: unknown): AgenticBenchmarkReplayResult {
  const parsed = AgenticBenchmarkReplayResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_BENCHMARK_REPLAY_RESULT_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  const result = parsed.data;
  if (
    result.valid !==
    (result.schemaValid &&
      result.sourceManifestValid &&
      result.sourceBindingValid &&
      result.policyDigestValid &&
      result.protocolDigestValid &&
      result.fingerprintDigestValid &&
      result.comparisonScopeDigestValid &&
      result.artifactDigestValid &&
      result.summarySemanticsValid)
  ) {
    throw new ContractError("AGENTIC_BENCHMARK_REPLAY_RESULT_INCONSISTENT");
  }
  return result;
}

export function parseAgenticBenchmarkAcquisitionRequest(
  value: unknown,
): AgenticBenchmarkAcquisitionRequest {
  const parsed = AgenticBenchmarkAcquisitionRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_BENCHMARK_ACQUISITION_REQUEST_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  parseVerificationRequest(parsed.data.verificationRequest);
  if (
    !parsed.data.verificationRequest.worlds.some(
      (world) =>
        world.id === parsed.data.referenceWorldId && world.kind === "REFERENCE" && world.required,
    )
  ) {
    throw new ContractError("AGENTIC_BENCHMARK_ACQUISITION_REFERENCE_INVALID");
  }
  const maximumAcquisitionExecutions =
    parsed.data.verificationRequest.policy.maximumSelectedCandidates *
    (parsed.data.policy.coldMeasuredSamples +
      parsed.data.policy.warmupSamples +
      parsed.data.policy.warmMeasuredSamples);
  if (
    !Number.isSafeInteger(maximumAcquisitionExecutions) ||
    maximumAcquisitionExecutions > parsed.data.policy.maximumExecutions
  ) {
    throw new ContractError("AGENTIC_BENCHMARK_ACQUISITION_EXECUTION_BUDGET_EXCEEDED");
  }
  const dependencyPaths = new Set(parsed.data.identityFiles.dependencyGraph);
  if (dependencyPaths.size !== parsed.data.identityFiles.dependencyGraph.length) {
    throw new ContractError("AGENTIC_BENCHMARK_ACQUISITION_IDENTITY_INVALID");
  }
  return parsed.data;
}

export function parseAgenticBenchmarkAcquisitionResult(
  value: unknown,
): AgenticBenchmarkAcquisitionResult {
  const parsed = AgenticBenchmarkAcquisitionResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_BENCHMARK_ACQUISITION_RESULT_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  parseEvidenceManifest(parsed.data.sourceManifest);
  if (parsed.data.benchmarkArtifact !== null) {
    parseAgenticBenchmarkArtifact(parsed.data.benchmarkArtifact);
  }
  if ((parsed.data.status === "SOURCE_NOT_VERIFIED") !== (parsed.data.benchmarkArtifact === null)) {
    throw new ContractError("AGENTIC_BENCHMARK_ACQUISITION_RESULT_INCONSISTENT");
  }
  return parsed.data;
}

export function parseAgenticBenchmarkAcquisitionReplayResult(
  value: unknown,
): AgenticBenchmarkAcquisitionReplayResult {
  const parsed = AgenticBenchmarkAcquisitionReplayResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_BENCHMARK_ACQUISITION_REPLAY_RESULT_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  const result = parsed.data;
  if (
    result.valid !==
    (result.schemaValid &&
      result.sourceManifestValid &&
      result.sourceBindingValid &&
      result.artifactReplayValid &&
      result.contextBindingValid &&
      result.resultDigestValid &&
      result.statusSemanticsValid)
  ) {
    throw new ContractError("AGENTIC_BENCHMARK_ACQUISITION_REPLAY_RESULT_INCONSISTENT");
  }
  return result;
}

function validateAgenticProfilePolicyV2(policy: AgenticProfilePolicyV2): void {
  const laneIds = new Set<string>();
  let previousMaximum = 0;
  for (const lane of policy.lanes) {
    if (laneIds.has(lane.id) || lane.maximumWarmTotalWallP95Us <= previousMaximum) {
      throw new ContractError("AGENTIC_PROFILE_V2_POLICY_INVALID");
    }
    laneIds.add(lane.id);
    previousMaximum = lane.maximumWarmTotalWallP95Us;
  }
}

export function parseAgenticProfileRequestV2(value: unknown): AgenticProfileRequestV2 {
  const parsed = AgenticProfileRequestV2Schema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("AGENTIC_PROFILE_V2_REQUEST_INVALID", z.prettifyError(parsed.error));
  }
  parseAgenticBenchmarkArtifact(parsed.data.benchmarkArtifact);
  validateAgenticProfilePolicyV2(parsed.data.policy);
  return parsed.data;
}

export function parseAgenticProfileReportV2(value: unknown): AgenticProfileReportV2 {
  const parsed = AgenticProfileReportV2Schema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("AGENTIC_PROFILE_V2_REPORT_INVALID", z.prettifyError(parsed.error));
  }
  const report = parsed.data;
  parseAgenticBenchmarkArtifact(report.benchmarkArtifact);
  validateAgenticProfilePolicyV2(report.policy);
  const universeIds = new Set(report.candidateUniverse.candidateIds);
  const candidateIds = new Set(report.candidates.map((candidate) => candidate.id));
  const excludedIds = new Set(report.candidateUniverse.excludedEligibleCandidateIds);
  if (
    universeIds.size !== report.candidateUniverse.candidateIds.length ||
    candidateIds.size !== report.candidates.length ||
    excludedIds.size !== report.candidateUniverse.excludedEligibleCandidateIds.length ||
    candidateIds.size !== universeIds.size ||
    [...candidateIds].some((id) => !universeIds.has(id)) ||
    [...excludedIds].some((id) => universeIds.has(id))
  ) {
    throw new ContractError("AGENTIC_PROFILE_V2_REPORT_INCONSISTENT");
  }
  return report;
}

export function parseAgenticProfileReplayResultV2(value: unknown): AgenticProfileReplayResultV2 {
  const parsed = AgenticProfileReplayResultV2Schema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_PROFILE_V2_REPLAY_RESULT_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  const result = parsed.data;
  if (
    result.valid !==
    (result.schemaValid &&
      result.sourceBenchmarkValid &&
      result.sourceBindingValid &&
      result.policyDigestValid &&
      result.reportDigestValid &&
      result.semanticsValid)
  ) {
    throw new ContractError("AGENTIC_PROFILE_V2_REPLAY_RESULT_INCONSISTENT");
  }
  return result;
}

export function parseAgenticCorpusTrustPolicy(value: unknown): AgenticCorpusTrustPolicy {
  const parsed = AgenticCorpusTrustPolicySchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("AGENTIC_CORPUS_TRUST_POLICY_INVALID", z.prettifyError(parsed.error));
  }
  const keyIds = new Set(parsed.data.keys.map((key) => key.keyId));
  const sourceIds = new Set(parsed.data.sources.map((source) => source.sourceId));
  const sourceIdentityDigests = new Set(
    parsed.data.sources.map((source) => source.sourceIdentityDigest),
  );
  if (
    keyIds.size !== parsed.data.keys.length ||
    sourceIds.size !== parsed.data.sources.length ||
    sourceIdentityDigests.size !== parsed.data.sources.length ||
    parsed.data.keys.some((key) => new Set(key.roles).size !== key.roles.length) ||
    parsed.data.sources.some(
      (source) =>
        new Set(source.authorizedAuthorSubjectIds).size !==
          source.authorizedAuthorSubjectIds.length ||
        new Set(source.authorizedReviewerSubjectIds).size !==
          source.authorizedReviewerSubjectIds.length,
    )
  ) {
    throw new ContractError("AGENTIC_CORPUS_TRUST_POLICY_INVALID");
  }
  return parsed.data;
}

export function parseAgenticCorpusProvenance(value: unknown): AgenticCorpusProvenance {
  const parsed = AgenticCorpusProvenanceSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("AGENTIC_CORPUS_PROVENANCE_INVALID", z.prettifyError(parsed.error));
  }
  if (
    new Set(parsed.data.execution.evidenceDigests).size !==
    parsed.data.execution.evidenceDigests.length
  ) {
    throw new ContractError("AGENTIC_CORPUS_PROVENANCE_INVALID");
  }
  return parsed.data;
}

function assertPortableIdentifierCollection(values: readonly string[], code: string): void {
  const portableKeys = new Set(values.map((value) => value.normalize("NFC").toLowerCase()));
  if (portableKeys.size !== values.length) throw new ContractError(code);
}

export function parseAgenticCorpusAllocationRequest(
  value: unknown,
): AgenticCorpusAllocationRequest {
  const parsed = AgenticCorpusAllocationRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_CORPUS_ALLOCATION_REQUEST_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  assertPortableIdentifierCollection(
    parsed.data.strata.map((stratum) => stratum.sourceId),
    "AGENTIC_CORPUS_ALLOCATION_REQUEST_INVALID",
  );
  assertUniqueStrings(
    parsed.data.strata.map((stratum) => stratum.sourceIdentityDigest),
    "AGENTIC_CORPUS_ALLOCATION_REQUEST_INVALID",
  );
  assertPortableIdentifierCollection(
    parsed.data.strata.flatMap((stratum) => stratum.caseIds),
    "AGENTIC_CORPUS_ALLOCATION_REQUEST_INVALID",
  );
  if (parsed.data.strata.some((stratum) => stratum.calibrationCount >= stratum.caseIds.length))
    throw new ContractError("AGENTIC_CORPUS_ALLOCATION_REQUEST_INVALID");
  return parsed.data;
}

export function parseAgenticCorpusAllocation(value: unknown): AgenticCorpusAllocation {
  const parsed = AgenticCorpusAllocationSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError("AGENTIC_CORPUS_ALLOCATION_INVALID", z.prettifyError(parsed.error));
  }
  const allocation = parsed.data;
  const stratumCalibrationCount = allocation.strata.reduce(
    (total, stratum) => total + stratum.calibrationCount,
    0,
  );
  const stratumSourceCaseIds = allocation.strata.flatMap((stratum) => stratum.sourceCaseIds);
  const stratumCalibrationCaseIds = allocation.strata.flatMap(
    (stratum) => stratum.calibrationCaseIds,
  );
  const stratumHoldoutCaseIds = allocation.strata.flatMap((stratum) => stratum.holdoutCaseIds);
  if (
    allocation.calibrationCount !== stratumCalibrationCount ||
    allocation.calibrationCaseIds.length !== allocation.calibrationCount ||
    allocation.holdoutCaseIds.length !==
      allocation.sourceCaseIds.length - allocation.calibrationCount ||
    allocation.assignments.length !== allocation.sourceCaseIds.length ||
    new Set(allocation.strata.map((stratum) => stratum.sourceId)).size !==
      allocation.strata.length ||
    new Set(allocation.strata.map((stratum) => stratum.sourceIdentityDigest)).size !==
      allocation.strata.length ||
    allocation.strata.some(
      (stratum) =>
        stratum.calibrationCount >= stratum.sourceCaseIds.length ||
        stratum.calibrationCaseIds.length !== stratum.calibrationCount ||
        stratum.holdoutCaseIds.length !== stratum.sourceCaseIds.length - stratum.calibrationCount,
    ) ||
    new Set(stratumSourceCaseIds).size !== stratumSourceCaseIds.length ||
    new Set(stratumCalibrationCaseIds).size !== stratumCalibrationCaseIds.length ||
    new Set(stratumHoldoutCaseIds).size !== stratumHoldoutCaseIds.length
  ) {
    throw new ContractError("AGENTIC_CORPUS_ALLOCATION_INVALID");
  }
  assertPortableIdentifierCollection(allocation.sourceCaseIds, "AGENTIC_CORPUS_ALLOCATION_INVALID");
  assertPortableIdentifierCollection(
    [...allocation.calibrationCaseIds, ...allocation.holdoutCaseIds],
    "AGENTIC_CORPUS_ALLOCATION_INVALID",
  );
  assertPortableIdentifierCollection(
    allocation.assignments.map((assignment) => assignment.caseId),
    "AGENTIC_CORPUS_ALLOCATION_INVALID",
  );
  return allocation;
}

export function parseAgenticCorpusAllocationReplayResult(
  value: unknown,
): AgenticCorpusAllocationReplayResult {
  const parsed = AgenticCorpusAllocationReplayResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_CORPUS_ALLOCATION_REPLAY_RESULT_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  const result = parsed.data;
  if (
    result.valid !==
    (result.schemaValid &&
      result.allocationDigestValid &&
      result.sourceCaseIdsValid &&
      result.assignmentScoresValid &&
      result.partitionSemanticsValid)
  ) {
    throw new ContractError("AGENTIC_CORPUS_ALLOCATION_REPLAY_RESULT_INCONSISTENT");
  }
  return result;
}

function assertUniqueStrings(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new ContractError(code);
}

export function parseAgenticCorpusAllocationCommitment(
  value: unknown,
): AgenticCorpusAllocationCommitment {
  const parsed = AgenticCorpusAllocationCommitmentSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_CORPUS_ALLOCATION_COMMITMENT_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  assertPortableIdentifierCollection(
    parsed.data.caseSet.map((item) => item.caseId),
    "AGENTIC_CORPUS_ALLOCATION_COMMITMENT_INVALID",
  );
  assertUniqueStrings(
    parsed.data.signers.map((item) => item.keyId),
    "AGENTIC_CORPUS_ALLOCATION_COMMITMENT_INVALID",
  );
  assertUniqueStrings(
    parsed.data.signers.map((item) => item.role),
    "AGENTIC_CORPUS_ALLOCATION_COMMITMENT_INVALID",
  );
  assertPortableIdentifierCollection(
    parsed.data.strata.map((item) => item.sourceId),
    "AGENTIC_CORPUS_ALLOCATION_COMMITMENT_INVALID",
  );
  assertUniqueStrings(
    parsed.data.strata.map((item) => item.sourceIdentityDigest),
    "AGENTIC_CORPUS_ALLOCATION_COMMITMENT_INVALID",
  );
  const casesBySource = new Map<string, number>();
  for (const item of parsed.data.caseSet) {
    const key = `${item.sourceId}\0${item.sourceIdentityDigest}`;
    casesBySource.set(key, (casesBySource.get(key) ?? 0) + 1);
  }
  if (
    parsed.data.strata.length !== casesBySource.size ||
    parsed.data.strata.some((stratum) => {
      const count = casesBySource.get(`${stratum.sourceId}\0${stratum.sourceIdentityDigest}`) ?? 0;
      return count < 2 || stratum.calibrationCount >= count;
    })
  ) {
    throw new ContractError("AGENTIC_CORPUS_ALLOCATION_COMMITMENT_INVALID");
  }
  return parsed.data;
}

export function parseAgenticCorpusAllocationReveal(value: unknown): AgenticCorpusAllocationReveal {
  const parsed = AgenticCorpusAllocationRevealSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_CORPUS_ALLOCATION_REVEAL_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  assertUniqueStrings(
    parsed.data.shares.map((item) => item.keyId),
    "AGENTIC_CORPUS_ALLOCATION_REVEAL_INVALID",
  );
  return parsed.data;
}

function parseConjunctiveResult<T extends { valid: boolean }>(
  schema: z.ZodType<T>,
  value: unknown,
  code: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ContractError(code, z.prettifyError(parsed.error));
  const { valid: _valid, ...rails } = parsed.data;
  if (parsed.data.valid !== Object.values(rails).every(Boolean)) {
    throw new ContractError(`${code}_INCONSISTENT`);
  }
  return parsed.data;
}

export function parseAgenticCorpusAllocationCommitmentReplayResult(
  value: unknown,
): AgenticCorpusAllocationCommitmentReplayResult {
  return parseConjunctiveResult(
    AgenticCorpusAllocationCommitmentReplayResultSchema,
    value,
    "AGENTIC_CORPUS_ALLOCATION_COMMITMENT_REPLAY_RESULT_INVALID",
  );
}

export function parseAgenticCorpusExperimentPlan(value: unknown): AgenticCorpusExperimentPlan {
  const parsed = AgenticCorpusExperimentPlanSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_CORPUS_EXPERIMENT_PLAN_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  const code = "AGENTIC_CORPUS_EXPERIMENT_PLAN_INVALID";
  assertPortableIdentifierCollection(
    parsed.data.subjects.map((item) => item.caseId),
    code,
  );
  assertPortableIdentifierCollection(
    parsed.data.adapters.map((item) => item.adapterId),
    code,
  );
  assertPortableIdentifierCollection(
    parsed.data.commands.map((item) => item.commandId),
    code,
  );
  assertPortableIdentifierCollection(
    parsed.data.schedule.map((item) => item.runId),
    code,
  );
  for (const arm of [parsed.data.arms.baseline, parsed.data.arms.profile]) {
    assertPortableIdentifierCollection(
      arm.candidateUniverse.map((candidate) => candidate.candidateId),
      code,
    );
    assertPortableIdentifierCollection(
      arm.selectedCandidates.map((candidate) => candidate.candidateId),
      code,
    );
    const universe = new Map(
      arm.candidateUniverse.map((candidate) => [candidate.candidateId, candidate.candidateDigest]),
    );
    if (
      arm.selectedCandidates.some(
        (candidate) => universe.get(candidate.candidateId) !== candidate.candidateDigest,
      )
    ) {
      throw new ContractError(code);
    }
  }
  return parsed.data;
}

export function parseAgenticCorpusExperimentPlanReplayResult(
  value: unknown,
): AgenticCorpusExperimentPlanReplayResult {
  return parseConjunctiveResult(
    AgenticCorpusExperimentPlanReplayResultSchema,
    value,
    "AGENTIC_CORPUS_EXPERIMENT_PLAN_REPLAY_RESULT_INVALID",
  );
}

function validateAgenticCorpusExperimentCommon(
  value: AgenticCorpusExperimentRequest | AgenticCorpusExperimentArtifact,
  code: string,
): void {
  assertPortableIdentifierCollection(
    value.payload.cases.map((item) => item.caseId),
    code,
  );
  assertPortableIdentifierCollection(
    value.evidenceBindings.map((item) => item.runId),
    code,
  );
  assertUniqueStrings(
    value.evidenceBindings.map((item) => item.receiptDigest),
    code,
  );
  assertUniqueStrings(
    value.evidenceBindings.map((item) => item.receiptContentDigest),
    code,
  );
  const runIds: string[] = [];
  for (const item of value.payload.cases) {
    for (const attempts of [item.baselineAttempts, item.profileAttempts]) {
      assertUniqueStrings(
        attempts.map((attempt) => String(attempt.ordinal)),
        code,
      );
      for (const attempt of attempts) runIds.push(...Object.values(attempt.runIds));
    }
  }
  assertUniqueStrings(runIds, code);
}

export function parseAgenticCorpusExperimentRequest(
  value: unknown,
): AgenticCorpusExperimentRequest {
  const parsed = AgenticCorpusExperimentRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_CORPUS_EXPERIMENT_REQUEST_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  validateAgenticCorpusExperimentCommon(parsed.data, "AGENTIC_CORPUS_EXPERIMENT_REQUEST_INVALID");
  return parsed.data;
}

export function parseAgenticCorpusExperimentArtifact(
  value: unknown,
): AgenticCorpusExperimentArtifact {
  const parsed = AgenticCorpusExperimentArtifactSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_CORPUS_EXPERIMENT_ARTIFACT_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  validateAgenticCorpusExperimentCommon(parsed.data, "AGENTIC_CORPUS_EXPERIMENT_ARTIFACT_INVALID");
  return parsed.data;
}

export function parseAgenticCorpusExperimentReplayRequest(
  value: unknown,
): AgenticCorpusExperimentReplayRequest {
  const parsed = AgenticCorpusExperimentReplayRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_CORPUS_EXPERIMENT_REPLAY_REQUEST_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  parseAgenticCorpusExperimentArtifact(parsed.data.artifact);
  return parsed.data;
}

export function parseAgenticCorpusExperimentReplayResult(
  value: unknown,
): AgenticCorpusExperimentReplayResult {
  const parsed = AgenticCorpusExperimentReplayResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_CORPUS_EXPERIMENT_REPLAY_RESULT_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  const result = parsed.data;
  const { valid: _valid, ...rails } = result;
  if (result.valid !== Object.values(rails).every(Boolean)) {
    throw new ContractError("AGENTIC_CORPUS_EXPERIMENT_REPLAY_RESULT_INCONSISTENT");
  }
  return result;
}

export function parseAgenticCorpusExperimentReceipt(
  value: unknown,
): AgenticCorpusExperimentReceipt {
  const parsed = AgenticCorpusExperimentReceiptSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_CORPUS_EXPERIMENT_RECEIPT_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  return parsed.data;
}

export function parseAgenticCorpusExperimentStructuredResult(
  value: unknown,
): AgenticCorpusExperimentStructuredResult {
  const parsed = AgenticCorpusExperimentStructuredResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ContractError(
      "AGENTIC_CORPUS_EXPERIMENT_STRUCTURED_RESULT_INVALID",
      z.prettifyError(parsed.error),
    );
  }
  if (parsed.data.attributed && parsed.data.outcome !== "ASSERTION_FAILURE") {
    throw new ContractError("AGENTIC_CORPUS_EXPERIMENT_STRUCTURED_RESULT_INVALID");
  }
  return parsed.data;
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

export function repositoryAuditJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    RepositoryAuditSchema,
    "https://testforge.dev/schemas/repository-audit.v1.json",
  );
}

export function repositoryInitConfigJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    RepositoryInitConfigSchema,
    "https://testforge.dev/schemas/repository-init-config.v1.json",
  );
}

export function repositoryInitLockJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    RepositoryInitLockSchema,
    "https://testforge.dev/schemas/repository-init-lock.v1.json",
  );
}

export function repositoryInitResultJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    RepositoryInitResultSchema,
    "https://testforge.dev/schemas/repository-init-result.v1.json",
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

export function agenticProfileRequestJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticProfileRequestSchema,
    "https://testforge.dev/schemas/agentic-profile-request.v1.json",
  );
}

export function agenticProfileReportJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticProfileReportSchema,
    "https://testforge.dev/schemas/agentic-profile-report.v1.json",
  );
}

export function agenticProfileReplayResultJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticProfileReplayResultSchema,
    "https://testforge.dev/schemas/agentic-profile-replay-result.v1.json",
  );
}

export function agenticBenchmarkRequestJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticBenchmarkRequestSchema,
    "https://testforge.dev/schemas/agentic-benchmark-request.v1.json",
  );
}

export function agenticBenchmarkArtifactJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticBenchmarkArtifactSchema,
    "https://testforge.dev/schemas/agentic-benchmark-artifact.v1.json",
  );
}

export function agenticBenchmarkReplayResultJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticBenchmarkReplayResultSchema,
    "https://testforge.dev/schemas/agentic-benchmark-replay-result.v1.json",
  );
}

export function agenticBenchmarkAcquisitionRequestJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticBenchmarkAcquisitionRequestSchema,
    "https://testforge.dev/schemas/agentic-benchmark-acquisition-request.v1.json",
  );
}

export function agenticBenchmarkAcquisitionResultJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticBenchmarkAcquisitionResultSchema,
    "https://testforge.dev/schemas/agentic-benchmark-acquisition-result.v1.json",
  );
}

export function agenticBenchmarkAcquisitionReplayResultJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticBenchmarkAcquisitionReplayResultSchema,
    "https://testforge.dev/schemas/agentic-benchmark-acquisition-replay-result.v1.json",
  );
}

export function agenticProfileRequestV2JsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticProfileRequestV2Schema,
    "https://testforge.dev/schemas/agentic-profile-request.v2.json",
  );
}

export function agenticProfileReportV2JsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticProfileReportV2Schema,
    "https://testforge.dev/schemas/agentic-profile-report.v2.json",
  );
}

export function agenticProfileReplayResultV2JsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticProfileReplayResultV2Schema,
    "https://testforge.dev/schemas/agentic-profile-replay-result.v2.json",
  );
}

export function agenticCorpusTrustPolicyJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticCorpusTrustPolicySchema,
    "https://testforge.dev/schemas/agentic-corpus-trust-policy.v1.json",
  );
}

export function agenticCorpusProvenanceJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticCorpusProvenanceSchema,
    "https://testforge.dev/schemas/agentic-corpus-provenance.v1.json",
  );
}

export function agenticCorpusAllocationRequestJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticCorpusAllocationRequestSchema,
    "https://testforge.dev/schemas/agentic-corpus-allocation-request.v1.json",
  );
}

export function agenticCorpusAllocationJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticCorpusAllocationSchema,
    "https://testforge.dev/schemas/agentic-corpus-allocation.v1.json",
  );
}

export function agenticCorpusAllocationReplayResultJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticCorpusAllocationReplayResultSchema,
    "https://testforge.dev/schemas/agentic-corpus-allocation-replay-result.v1.json",
  );
}

export function agenticCorpusAllocationCommitmentJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticCorpusAllocationCommitmentSchema,
    "https://testforge.dev/schemas/agentic-corpus-allocation-commitment.v1.json",
  );
}

export function agenticCorpusAllocationRevealJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticCorpusAllocationRevealSchema,
    "https://testforge.dev/schemas/agentic-corpus-allocation-reveal.v1.json",
  );
}

export function agenticCorpusAllocationCommitmentReplayResultJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticCorpusAllocationCommitmentReplayResultSchema,
    "https://testforge.dev/schemas/agentic-corpus-allocation-commitment-replay-result.v1.json",
  );
}

export function agenticCorpusExperimentPlanJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticCorpusExperimentPlanSchema,
    "https://testforge.dev/schemas/agentic-corpus-experiment-plan.v1.json",
  );
}

export function agenticCorpusExperimentPlanReplayResultJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticCorpusExperimentPlanReplayResultSchema,
    "https://testforge.dev/schemas/agentic-corpus-experiment-plan-replay-result.v1.json",
  );
}

export function agenticCorpusExperimentRequestJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticCorpusExperimentRequestSchema,
    "https://testforge.dev/schemas/agentic-corpus-experiment-request.v1.json",
  );
}

export function agenticCorpusExperimentArtifactJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticCorpusExperimentArtifactSchema,
    "https://testforge.dev/schemas/agentic-corpus-experiment-artifact.v1.json",
  );
}

export function agenticCorpusExperimentReplayRequestJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticCorpusExperimentReplayRequestSchema,
    "https://testforge.dev/schemas/agentic-corpus-experiment-replay-request.v1.json",
  );
}

export function agenticCorpusExperimentReplayResultJsonSchema(): Record<string, unknown> {
  return jsonSchemaFor(
    AgenticCorpusExperimentReplayResultSchema,
    "https://testforge.dev/schemas/agentic-corpus-experiment-replay-result.v1.json",
  );
}
