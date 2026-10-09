import * as z from "zod";

export const QualificationJsonSchema = z.json();
export type QualificationJson = z.infer<typeof QualificationJsonSchema>;
const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const RelativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes(":") &&
      !value.startsWith("/") &&
      value
        .split("/")
        .every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            [...part].every((character) => character.charCodeAt(0) >= 32) &&
            !/[. ]$/.test(part) &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ),
    "Expected a portable relative path",
  );
const File = z.strictObject({ path: RelativePath, content: z.string().max(1_048_576) });
const Check = z.strictObject({
  id: Id,
  actionId: Id,
  field: z.string().min(1).max(512),
  expected: QualificationJsonSchema,
});
export const QualificationObservationSchema = z.strictObject({
  worldId: Id,
  attempt: z.int().min(1).max(10),
  actionId: Id,
  state: z.enum(["COMPLETED", "TIMEOUT", "CRASH", "INFRA_ERROR", "COLLECTION_ERROR", "NO_TESTS"]),
  facts: z.record(z.string(), QualificationJsonSchema),
  bindingDigest: Digest,
});
export type QualificationObservation = z.infer<typeof QualificationObservationSchema>;
export const QualificationPlanSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  profileId: Id,
  subject: z.strictObject({
    commit: z.string().min(1).max(128),
    baseCommit: z.string().min(1).max(128),
    candidateDigest: Digest,
    inputDigest: Digest,
  }),
  ciTrust: z
    .strictObject({
      repositoryId: z.string().min(1).max(512),
      observerId: Id,
      publicKeyPem: z.string().min(1).max(8192),
      requiredSteps: z
        .array(z.strictObject({ id: Id, commandDigest: Digest }))
        .min(1)
        .max(1000),
    })
    .optional(),
  tools: z
    .array(
      z.strictObject({
        id: Id,
        version: z.string().min(1).max(128),
        digest: Digest,
        identityPath: z
          .string()
          .min(1)
          .max(4096)
          .refine(
            (value) =>
              /^(?:[A-Za-z]:[\\/]|\/|\\\\[^\\]+\\[^\\]+)/.test(value) &&
              [...value].every((character) => character.charCodeAt(0) >= 32),
            "Tool identity must name an absolute path",
          )
          .optional(),
        versionCommand: z
          .strictObject({
            executable: z.string().min(1).max(4096),
            arguments: z.array(z.string().max(8192)).max(100),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(100),
  suites: z
    .array(
      z.strictObject({
        id: Id,
        files: z.array(RelativePath).max(1000),
        extraction: z.enum(["COMPLETE", "UNAVAILABLE", "OMITTED"]),
      }),
    )
    .max(1000),
  obligations: z
    .array(
      z.strictObject({
        id: Id,
        kind: z.enum([
          "tests",
          "selection",
          "cache",
          "propagation",
          "wrapper",
          "ci-config",
          "ci-local",
          "ci-live",
        ]),
        required: z.boolean(),
        suiteIds: z.array(Id).max(1000),
        checks: z.array(Check).min(1).max(1000),
        limits: z.array(z.string().min(1).max(2048)).max(100),
      }),
    )
    .min(1)
    .max(1000),
  actions: z
    .array(
      z.strictObject({
        id: Id,
        adapter: z.enum(["command", "turbo", "node-test", "bun-native", "ci-config"]),
        executable: z.string().min(1).max(1024),
        arguments: z.array(z.string().max(8192)).max(100),
        environment: z.record(
          z
            .string()
            .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
            .refine(
              (key) =>
                !/^(NODE_OPTIONS|NODE_TEST_|TESTFORGE_|ASSERTLEDGER_|QUALIFICATION_|HOME$|USERPROFILE$|COMSPEC$|SHELL$)/i.test(
                  key,
                ),
              "Reserved environment key",
            ),
          z.string().max(8192),
        ),
        prepareFiles: z.array(File).max(1000),
        removePaths: z.array(RelativePath).max(1000),
        observe: z.strictObject({
          trace: z.boolean(),
          outputs: z.array(RelativePath).max(1000),
          report: RelativePath.nullable(),
        }),
      }),
    )
    .min(1)
    .max(1000),
  worlds: z
    .array(
      z.strictObject({
        id: Id,
        kind: z.enum(["REFERENCE", "TARGET", "NEUTRAL"]),
        files: z.array(File).max(1000),
        discriminants: z
          .array(z.strictObject({ obligationId: Id, checkIds: z.array(Id).min(1).max(1000) }))
          .max(1000),
      }),
    )
    .min(2)
    .max(1000),
  requiredAttempts: z.int().min(2).max(10),
  timeoutMs: z.int().min(1).max(600_000),
  maximumOutputBytes: z.int().min(1).max(16_777_216),
  isolation: z.strictObject({
    kind: z.literal("trusted-local"),
    acknowledgedUnsafeExecution: z.literal(true),
  }),
  allowedCandidatePaths: z.array(RelativePath).max(1000),
});
export type QualificationPlan = z.infer<typeof QualificationPlanSchema>;

export const QualificationExecutionRequestSchema = z.strictObject({
  root: z.string().min(1).max(4096),
  plan: QualificationPlanSchema,
  planDigest: Digest,
  candidate: z.strictObject({ files: z.array(File).max(1000) }),
});
export type QualificationExecutionRequest = z.infer<typeof QualificationExecutionRequestSchema>;
export const QualificationExpectedDomainSchema = z.strictObject({
  planDigest: Digest,
  candidateDigest: Digest,
  inputDigest: Digest,
  commit: z.string().min(1).max(128),
  baseCommit: z.string().min(1).max(128),
  mechanismDigest: Digest.optional(),
});
export type QualificationExpectedDomain = z.infer<typeof QualificationExpectedDomainSchema>;

export function parseQualificationPlan(value: unknown): QualificationPlan {
  const plan = QualificationPlanSchema.parse(value);
  const unique = (ids: string[], label: string) => {
    if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length)
      throw new Error(`Duplicate ${label}`);
  };
  for (const [label, items] of [
    ["tool", plan.tools],
    ["suite", plan.suites],
    ["obligation", plan.obligations],
    ["action", plan.actions],
    ["world", plan.worlds],
  ] as const)
    unique(
      items.map((item) => item.id),
      label,
    );
  unique(plan.allowedCandidatePaths, "candidate path");
  if (plan.ciTrust)
    unique(
      plan.ciTrust.requiredSteps.map((step) => step.id),
      "CI required step",
    );
  const actions = new Set(plan.actions.map((action) => action.id));
  const suites = new Set(plan.suites.map((suite) => suite.id));
  for (const suite of plan.suites) unique(suite.files, "suite file");
  for (const obligation of plan.obligations) {
    unique(obligation.suiteIds, "suite reference");
    unique(
      obligation.checks.map((check) => check.id),
      "check",
    );
    if (
      obligation.suiteIds.some((id) => !suites.has(id)) ||
      obligation.checks.some((check) => !actions.has(check.actionId))
    )
      throw new Error("Unknown obligation reference");
    if (obligation.kind === "tests" && obligation.suiteIds.length === 0)
      throw new Error("Test obligation requires a suite");
  }
  for (const action of plan.actions) {
    unique(
      action.prepareFiles.map((file) => file.path),
      "prepare path",
    );
    unique(action.removePaths, "remove path");
    unique(action.observe.outputs, "output path");
  }
  if (!["REFERENCE", "NEUTRAL"].every((kind) => plan.worlds.some((world) => world.kind === kind)))
    throw new Error("Reference and neutral worlds required");
  for (const world of plan.worlds) {
    unique(
      world.files.map((file) => file.path),
      "world path",
    );
    unique(
      world.discriminants.map((item) => item.obligationId),
      "discriminant",
    );
    if (world.kind !== "TARGET" && world.discriminants.length > 0)
      throw new Error("Only target worlds declare discriminants");
    for (const discriminant of world.discriminants) {
      unique(discriminant.checkIds, "discriminant check");
      const obligation = plan.obligations.find((item) => item.id === discriminant.obligationId);
      if (
        !obligation ||
        discriminant.checkIds.some((id) => !obligation.checks.some((check) => check.id === id))
      )
        throw new Error("Unknown discriminant reference");
    }
  }
  return plan;
}

export const QualificationProvenanceSchema = z.strictObject({
  engineVersion: z.string().min(1),
  adapterVersions: z.record(z.string(), z.string().min(1)),
  runtime: QualificationJsonSchema,
  executionTrust: z.literal("TRUSTED_LOCAL_UNSANDBOXED"),
});
export const QualificationCiObservationSchema = z.strictObject({
  protocolVersion: z.literal("1.0.0"),
  provider: z.literal("bitbucket"),
  repositoryId: z.string().min(1).max(512),
  observerId: Id,
  commit: z.string().min(1).max(128),
  baseCommit: z.string().min(1).max(128),
  candidateDigest: Digest,
  inputDigest: Digest,
  planDigest: Digest,
  pipelineId: z.string().min(1).max(128),
  pipelineUrl: z.string().min(1).max(2048),
  steps: z
    .array(
      z.strictObject({
        id: Id,
        commandDigest: Digest,
        commit: z.string().min(1).max(128),
        result: z.enum(["SUCCESS", "FAILURE", "SKIPPED"]),
      }),
    )
    .max(1000),
  terminalResult: z.enum(["SUCCESS", "FAILURE", "STOPPED"]),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
});
export type QualificationCiObservation = z.infer<typeof QualificationCiObservationSchema>;
export const QualificationAssessmentSchema = z.strictObject({
  obligationId: Id,
  kind: z.string(),
  required: z.boolean(),
  status: z.enum(["COVERED", "OPEN", "REJECTED"]),
  reasons: z.array(z.string()),
  mismatchCheckIds: z.array(Id),
});
export const QualificationReceiptSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  plan: QualificationPlanSchema,
  planDigest: Digest,
  candidateDigest: Digest,
  observations: z.array(QualificationObservationSchema),
  provenance: QualificationProvenanceSchema,
  externalCi: QualificationJsonSchema.nullable(),
  assessments: z.array(QualificationAssessmentSchema),
  coveredGuaranteeIds: z.array(Id),
  openGuaranteeIds: z.array(Id),
  decision: z.enum(["QUALIFIED", "OPEN", "REJECTED"]),
  decisionDigest: Digest,
  artifactDigest: Digest,
});
export type QualificationReceipt = z.infer<typeof QualificationReceiptSchema>;
export const QualificationReplayResultSchema = z.strictObject({
  valid: z.boolean(),
  integrityValid: z.boolean(),
  semanticsValid: z.boolean(),
  domainValid: z.boolean(),
  reexecuted: z.literal(false),
  producerAuthenticated: z.literal(false),
});
export type QualificationReplayResult = z.infer<typeof QualificationReplayResultSchema>;
export function qualificationPlanJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(QualificationPlanSchema),
    $id: "https://testforge.dev/schemas/qualification-plan.v1.json",
    title: "Orchestration qualification plan v1",
  };
}
export function qualificationReceiptJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(QualificationReceiptSchema),
    $id: "https://testforge.dev/schemas/qualification-receipt.v1.json",
    title: "Orchestration qualification receipt v1",
  };
}
export function qualificationReplayResultJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(QualificationReplayResultSchema),
    $id: "https://testforge.dev/schemas/qualification-replay-result.v1.json",
    title: "Orchestration qualification replay result v1",
  };
}
export function qualificationExecutionRequestJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(QualificationExecutionRequestSchema),
    $id: "https://testforge.dev/schemas/qualification-execution-request.v1.json",
    title: "Orchestration qualification execution request v1",
  };
}
