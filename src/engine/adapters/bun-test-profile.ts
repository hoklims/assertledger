/** Bun's Inspector does not classify native expect() failures as assertions. */
export const BUN_TEST_ADAPTER_PROFILE = {
  profileId: "bun-test",
  profileVersion: "1.0.0",
  official: true,
  bunVersion: "1.4.2",
  bunRevision: "744846f844374847c902b5e7fd59b4342a51ef99",
  inspectorProtocolBlob: "ed5e1657d39cf929a3d1e7c5954aeca62b8ce69c",
  capabilities: {
    assertionSource: "assertledger-assertSame",
    attributesPerAssertionFailure: true,
    detectsCollectionFailure: false,
    detectsCompileFailure: false,
    inspectorTransport: "loopback-websocket",
    supportsContainer: false,
  },
} as const;
