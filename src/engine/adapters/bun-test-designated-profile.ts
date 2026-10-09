import { BUN_TEST_ADAPTER_PROFILE } from "./bun-test-profile.js";

/**
 * Runs one existing bun:test test, named by file and describe path. A failure thrown inside it by
 * a built-in matcher, with Bun's matcher message form, or by assertSame is an owned assertion; with
 * a declared expected line, only a failure whose first message line equals it is admitted.
 */
export const BUN_TEST_DESIGNATED_ADAPTER_PROFILE = {
  profileId: "bun-test-designated",
  profileVersion: "1.0.0",
  official: true,
  bunVersion: BUN_TEST_ADAPTER_PROFILE.bunVersion,
  bunRevision: BUN_TEST_ADAPTER_PROFILE.bunRevision,
  capabilities: {
    assertionSource: "bun-builtin-matcher-or-assertSame-issued-error",
    attributesPerAssertionFailure: true,
    controlMode: "load-designated-files-without-running-tests",
    detectsCollectionFailure: false,
    detectsCompileFailure: false,
    expectedFailureLine: "first-message-line-exact",
    reporterTransport: "signed-preload-pipe+junit",
    supportsContainer: true,
  },
} as const;
