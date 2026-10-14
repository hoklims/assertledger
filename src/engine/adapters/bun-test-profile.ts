/** Bun's native expect() failures are not AssertLedger-owned assertions. */
export const BUN_TEST_ADAPTER_PROFILE = {
  profileId: "bun-test",
  profileVersion: "1.2.0",
  official: true,
  bunVersion: "1.4.3",
  bunRevision: "c6da4a4d3010e5553438c60f6bd76d981976867c",
  capabilities: {
    assertionSource: "assertledger-assertSame-issued-error",
    attributesPerAssertionFailure: true,
    detectsCollectionFailure: false,
    detectsCompileFailure: false,
    reporterTransport: "signed-preload-pipe+junit",
    supportsContainer: false,
  },
} as const;
