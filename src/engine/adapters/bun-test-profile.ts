/** Bun's native expect() failures are not AssertLedger-owned assertions. */
export const BUN_TEST_ADAPTER_PROFILE = {
  profileId: "bun-test",
  profileVersion: "1.2.0",
  official: true,
  bunVersion: "1.4.4",
  bunRevision: "38afee6c84fcf48c0edb2466aa4b27d287a59c30",
  capabilities: {
    assertionSource: "assertledger-assertSame-issued-error",
    attributesPerAssertionFailure: true,
    detectsCollectionFailure: false,
    detectsCompileFailure: false,
    reporterTransport: "signed-preload-pipe+junit",
    supportsContainer: false,
  },
} as const;
