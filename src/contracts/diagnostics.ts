import * as z from "zod/v4";

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
