import * as z from "zod/v4";
import { ObservationOutcomeSchema } from "./index.js";

const BunProbeResultSchema = z.strictObject({
  outcome: ObservationOutcomeSchema,
  attributed: z.boolean(),
  testsDiscovered: z.number().int().nonnegative(),
  candidateTestsDiscovered: z.number().int().nonnegative(),
});

/** A refusal diagnostic, never a campaign manifest or a qualified observation. */
export const BunPreflightRefusalSchema = z.strictObject({
  schemaVersion: z.literal("1.0.0"),
  status: z.literal("REFUSED"),
  code: z.literal("BUN_TEST_PROFILE_PREFLIGHT_FAILED"),
  profile: z.enum(["bun-test", "bun-test-designated"]),
  probe: z.string().min(1),
  failure: z.enum(["REPORT_MISMATCH", "REPORT_UNAVAILABLE", "EXECUTION_ERROR"]),
  expected: BunProbeResultSchema,
  observed: z.strictObject({
    outcome: ObservationOutcomeSchema.nullable(),
    attributed: z.boolean().nullable(),
    testsDiscovered: z.number().int().nonnegative().nullable(),
    candidateTestsDiscovered: z.number().int().nonnegative().nullable(),
  }),
  process: z
    .strictObject({
      outcome: z.enum(["PASS", "PROCESS_CRASH", "TIMEOUT", "INFRA_ERROR"]),
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
      timedOut: z.boolean(),
      durationMs: z.number().int().nonnegative(),
    })
    .nullable(),
  detail: z.string().nullable(),
});
export type BunPreflightRefusal = z.infer<typeof BunPreflightRefusalSchema>;

export const DiagnosticCodesSchema = z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/)).max(128);
export const DiagnosticReportSchema = z.strictObject({
  catalogueVersion: z.literal("1.0.0"),
  diagnostics: z.array(
    z.strictObject({
      code: z.string(),
      known: z.boolean(),
      severity: z.enum(["info", "blocking", "limitation"]),
      explanation: z.string(),
      nextAction: z.string(),
    }),
  ),
});
export type DiagnosticReport = z.infer<typeof DiagnosticReportSchema>;
