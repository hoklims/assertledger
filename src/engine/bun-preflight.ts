import { type BunPreflightRefusal, BunPreflightRefusalSchema } from "../contracts/diagnostics.js";

/** Preserve the stable error message while carrying the failed controlled probe's facts. */
export class BunPreflightError extends Error {
  readonly diagnostic: BunPreflightRefusal;

  constructor(diagnostic: BunPreflightRefusal, cause?: unknown) {
    super("BUN_TEST_PROFILE_PREFLIGHT_FAILED", { cause });
    this.name = "BunPreflightError";
    this.diagnostic = BunPreflightRefusalSchema.parse(diagnostic);
  }
}

export function renderBunPreflightRefusal(diagnostic: BunPreflightRefusal): string {
  return [
    `Bun preflight: profile=${diagnostic.profile}, probe=${diagnostic.probe}, failure=${diagnostic.failure}`,
    `Expected: ${JSON.stringify(diagnostic.expected)}`,
    `Observed: ${JSON.stringify(diagnostic.observed)}`,
    ...(diagnostic.process === null ? [] : [`Process: ${JSON.stringify(diagnostic.process)}`]),
    ...(diagnostic.detail === null ? [] : [`Detail: ${JSON.stringify(diagnostic.detail)}`]),
  ].join("\n");
}
