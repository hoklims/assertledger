import {
  DiagnosticCodesSchema,
  type DiagnosticReport,
  DiagnosticReportSchema,
} from "./contracts/diagnostics.js";

export type { DiagnosticReport };
export { DiagnosticCodesSchema, DiagnosticReportSchema };

import { CATALOGUE, type Entry } from "./contracts/diagnostic-catalogue.js";
export type { KnownDiagnosticCode } from "./contracts/diagnostic-catalogue.js";

const catalogueLookup: Readonly<Record<string, Entry>> = CATALOGUE;

/** Derived guidance only: never changes a verdict or either manifest digest. */
export function explainReasonCodes(codes: readonly string[]): DiagnosticReport {
  const parsed = DiagnosticCodesSchema.safeParse(codes);
  if (!parsed.success) throw new TypeError("DIAGNOSTIC_CODES_INVALID");
  return DiagnosticReportSchema.parse({
    catalogueVersion: "1.0.0",
    diagnostics: [...new Set(parsed.data)].sort().map((code) => {
      const entry = catalogueLookup[code];
      return {
        code,
        known: entry !== undefined,
        severity: entry?.[2] ?? (entry ? "blocking" : "limitation"),
        explanation: entry?.[0] ?? "This code has no explanation in the installed catalogue.",
        nextAction:
          entry?.[1] ??
          "Keep the original result and consult the matching package version's reference; do not infer a pass.",
      };
    }),
  });
}

const LINK_REFUSAL_CODES = new Set([
  "UNSUPPORTED_REPOSITORY_SYMLINK",
  "REPOSITORY_LINK_IN_TEST_CLOSURE",
  "REPOSITORY_LINK_ESCAPES_ROOT",
  "TEST_CLOSURE_UNBOUNDED",
]);
const MAXIMUM_QUOTED_ENTRY_LENGTH = 200;

/** Quotes a repository entry name for a refusal message. A file name is repository content, so it
 * is untrusted: every character outside printable ASCII is escaped, and a long name is cut. */
export function quoteRepositoryEntry(entry: string): string {
  const quoted = JSON.stringify(entry.slice(0, MAXIMUM_QUOTED_ENTRY_LENGTH)).replace(
    /[^\x20-\x7e]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return entry.length > MAXIMUM_QUOTED_ENTRY_LENGTH ? `${quoted} (truncated)` : quoted;
}

/** The lines that follow the stable code when a repository link refuses an analysis: the link
 * itself, then the catalogue guidance. Undefined for any other error, or when no link is named. */
export function renderRepositoryLinkRefusal(error: unknown): string | undefined {
  if (
    !(error instanceof Error) ||
    !LINK_REFUSAL_CODES.has(error.message) ||
    typeof error.cause !== "string"
  ) {
    return undefined;
  }
  return `Link detail: ${quoteRepositoryEntry(error.cause)}\n${renderDiagnostics([error.message])}`;
}

export function renderDiagnostics(codes: readonly string[]): string {
  return explainReasonCodes(codes)
    .diagnostics.map(
      (entry) => `${entry.code}: ${entry.explanation}\nNext action: ${entry.nextAction}`,
    )
    .join("\n");
}
