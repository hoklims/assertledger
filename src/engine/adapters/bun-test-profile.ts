/** Bun's native expect() failures are not AssertLedger-owned assertions. */
export const BUN_TEST_ADAPTER_PROFILE = {
  profileId: "bun-test",
  profileVersion: "1.2.0",
  official: true,
  bunVersion: "1.4.4",
  bunRevision: "5d9cc0f4ff81c4dacf8f6952d44aa9cea4f48653",
  capabilities: {
    assertionSource: "assertledger-assertSame-issued-error",
    attributesPerAssertionFailure: true,
    detectsCollectionFailure: false,
    detectsCompileFailure: false,
    reporterTransport: "signed-preload-pipe+junit",
    supportsContainer: false,
  },
} as const;
