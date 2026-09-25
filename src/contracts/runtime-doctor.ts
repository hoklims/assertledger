import { z } from "zod";

export const RuntimeDoctorReasonCodeSchema = z.enum([
  "RUNTIME_ADAPTER_UNSUPPORTED",
  "RUNTIME_CONFIGURATION_BLOCKED",
  "RUNTIME_CONFIGURATION_STALE",
  "RUNTIME_CONFIGURATION_UNAVAILABLE",
  "RUNTIME_DEPENDENCY_UNAVAILABLE",
  "RUNTIME_EXECUTABLE_UNAVAILABLE",
  "RUNTIME_EXECUTION_NOT_AUTHORIZED",
  "RUNTIME_NODE_VERSION_UNSUPPORTED",
  "RUNTIME_PREFLIGHT_FAILED",
  "RUNTIME_REPOSITORY_TESTS_NOT_EXECUTED",
  "RUNTIME_TEMPORARY_WORKSPACE_UNAVAILABLE",
]);

export const RuntimeDoctorCheckSchema = z
  .object({
    id: z.enum([
      "authorization",
      "configuration",
      "adapter",
      "executable",
      "dependencies",
      "temporary-workspace",
      "synthetic-preflight",
      "repository-campaign",
    ]),
    status: z.enum(["PASS", "BLOCKED", "LIMITATION"]),
    reasonCode: RuntimeDoctorReasonCodeSchema.nullable(),
    summary: z.string().min(1),
    nextAction: z.string().min(1).nullable(),
  })
  .strict();

export const RuntimeDoctorResultSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    status: z.enum(["READY", "BLOCKED"]),
    executionMode: z.literal("UNSANDBOXED_TRUSTED_LOCAL"),
    repositoryRoot: z.string().min(1),
    adapter: z.literal("node:test").nullable(),
    nodeVersion: z.string().min(1).nullable(),
    checks: z.array(RuntimeDoctorCheckSchema).min(2),
    reasonCodes: z.array(RuntimeDoctorReasonCodeSchema),
    limitations: z.tuple([
      z.literal(
        "Runtime doctor uses controlled synthetic node:test probes and does not run repository tests or prove campaign evidence.",
      ),
    ]),
  })
  .strict();

export const RuntimeDoctorReasonCodeV2Schema = z.enum([
  ...RuntimeDoctorReasonCodeSchema.options,
  "RUNTIME_BUN_VERSION_UNSUPPORTED",
  "RUNTIME_BUN_EXECUTABLE_UNAVAILABLE",
  "RUNTIME_BUN_DEPENDENCY_UNAVAILABLE",
  "RUNTIME_BUN_PREFLIGHT_FAILED",
]);

export const RuntimeDoctorCheckV2Schema = z.strictObject({
  ...RuntimeDoctorCheckSchema.shape,
  reasonCode: RuntimeDoctorReasonCodeV2Schema.nullable(),
});

export const RuntimeDoctorResultV2Schema = z.strictObject({
  ...RuntimeDoctorResultSchema.shape,
  schemaVersion: z.literal("2.0.0"),
  adapter: z.literal("bun:test").nullable(),
  nodeVersion: z.null(),
  bunVersion: z.string().min(1).nullable(),
  checks: z.array(RuntimeDoctorCheckV2Schema).min(2),
  reasonCodes: z.array(RuntimeDoctorReasonCodeV2Schema),
  limitations: z.tuple([
    z.literal(
      "Runtime doctor uses controlled synthetic Bun callback probes and does not run repository tests or prove campaign evidence.",
    ),
  ]),
});

export type RuntimeDoctorResult = z.infer<typeof RuntimeDoctorResultSchema>;
export type RuntimeDoctorCheck = z.infer<typeof RuntimeDoctorCheckSchema>;
export type RuntimeDoctorResultV2 = z.infer<typeof RuntimeDoctorResultV2Schema>;
export type RuntimeDoctorCheckV2 = z.infer<typeof RuntimeDoctorCheckV2Schema>;

const EXECUTED_CHECK_ORDER: RuntimeDoctorCheck["id"][] = [
  "authorization",
  "configuration",
  "adapter",
  "executable",
  "dependencies",
  "temporary-workspace",
  "synthetic-preflight",
];

export function parseRuntimeDoctorResult(value: unknown): RuntimeDoctorResult {
  const parsed = RuntimeDoctorResultSchema.parse(value);
  const limitation = parsed.checks.at(-1);
  const executed = parsed.checks.slice(0, -1);
  const executedIds = executed.map((entry) => entry.id);
  const expectedIds = EXECUTED_CHECK_ORDER.slice(0, executed.length);
  const terminal = executed.at(-1);
  const ready = parsed.status === "READY";
  const structureInvalid =
    executed.length === 0 ||
    executed.length > EXECUTED_CHECK_ORDER.length ||
    JSON.stringify(executedIds) !== JSON.stringify(expectedIds) ||
    limitation?.id !== "repository-campaign" ||
    limitation.status !== "LIMITATION" ||
    limitation.reasonCode !== "RUNTIME_REPOSITORY_TESTS_NOT_EXECUTED" ||
    limitation.nextAction === null ||
    terminal === undefined ||
    (ready
      ? executed.length !== EXECUTED_CHECK_ORDER.length ||
        executed.some(
          (entry) =>
            entry.status !== "PASS" || entry.reasonCode !== null || entry.nextAction !== null,
        ) ||
        parsed.reasonCodes.length !== 0
      : terminal.status !== "BLOCKED" ||
        terminal.reasonCode === null ||
        terminal.nextAction === null ||
        executed
          .slice(0, -1)
          .some(
            (entry) =>
              entry.status !== "PASS" || entry.reasonCode !== null || entry.nextAction !== null,
          ) ||
        JSON.stringify(parsed.reasonCodes) !== JSON.stringify([terminal.reasonCode])) ||
    (parsed.adapter === "node:test") !== executed.length >= 4 ||
    (parsed.nodeVersion !== null) !== executed.length >= 5;
  if (structureInvalid) {
    throw new TypeError("RUNTIME_DOCTOR_RESULT_INVALID");
  }
  return parsed;
}

export function parseRuntimeDoctorResultV2(value: unknown): RuntimeDoctorResultV2 {
  const parsed = RuntimeDoctorResultV2Schema.parse(value);
  const limitation = parsed.checks.at(-1);
  const executed = parsed.checks.slice(0, -1);
  const executedIds = executed.map((entry) => entry.id);
  const expectedIds = EXECUTED_CHECK_ORDER.slice(0, executed.length);
  const terminal = executed.at(-1);
  const ready = parsed.status === "READY";
  const structureInvalid =
    executed.length === 0 ||
    executed.length > EXECUTED_CHECK_ORDER.length ||
    JSON.stringify(executedIds) !== JSON.stringify(expectedIds) ||
    limitation?.id !== "repository-campaign" ||
    limitation.status !== "LIMITATION" ||
    limitation.reasonCode !== "RUNTIME_REPOSITORY_TESTS_NOT_EXECUTED" ||
    limitation.nextAction === null ||
    terminal === undefined ||
    (ready
      ? executed.length !== EXECUTED_CHECK_ORDER.length ||
        executed.some(
          (entry) =>
            entry.status !== "PASS" || entry.reasonCode !== null || entry.nextAction !== null,
        ) ||
        parsed.reasonCodes.length !== 0
      : terminal.status !== "BLOCKED" ||
        terminal.reasonCode === null ||
        terminal.nextAction === null ||
        executed
          .slice(0, -1)
          .some(
            (entry) =>
              entry.status !== "PASS" || entry.reasonCode !== null || entry.nextAction !== null,
          ) ||
        JSON.stringify(parsed.reasonCodes) !== JSON.stringify([terminal.reasonCode])) ||
    (parsed.adapter === "bun:test") !== executed.length >= 4 ||
    (parsed.bunVersion !== null) !== executed.length >= 5;
  if (structureInvalid) throw new TypeError("RUNTIME_DOCTOR_RESULT_INVALID");
  return parsed;
}

export function parseVersionedRuntimeDoctorResult(
  value: unknown,
): RuntimeDoctorResult | RuntimeDoctorResultV2 {
  return typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === "2.0.0"
    ? parseRuntimeDoctorResultV2(value)
    : parseRuntimeDoctorResult(value);
}
