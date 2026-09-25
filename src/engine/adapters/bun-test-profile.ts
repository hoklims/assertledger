/** Bun's native expect() failures are not AssertLedger-owned assertions. */
export const BUN_TEST_ADAPTER_PROFILE = {
  profileId: "bun-test",
  profileVersion: "1.2.0",
  official: true,
  bunVersion: "1.4.2",
  bunRevision: "744846f844374847c902b5e7fd59b4342a51ef99",
  capabilities: {
    assertionSource: "assertledger-assertSame-issued-error",
    attributesPerAssertionFailure: true,
    detectsCollectionFailure: false,
    detectsCompileFailure: false,
    reporterTransport: "signed-preload-pipe+junit",
    supportsContainer: false,
  },
} as const;
