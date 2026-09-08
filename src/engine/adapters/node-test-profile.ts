import { createHash } from "node:crypto";
import { NODE_TEST_REPORTER_SOURCE } from "../node-test-reporter.js";

// Identity and capability declaration for the bundled, official node:test profile. It is derived
// deterministically without filesystem, process, network, or clock access.

export interface AdapterProfileCapabilities {
  detectsCollectionFailure: boolean;
  detectsCompileFailure: boolean;
  attributesPerAssertionFailure: boolean;
}

export interface AdapterProfileIdentity {
  profileId: string;
  profileVersion: string;
  official: true;
  reporterDigest: `sha256:${string}`;
  capabilities: AdapterProfileCapabilities;
}

export const NODE_TEST_ADAPTER_PROFILE: AdapterProfileIdentity = {
  profileId: "node-test",
  profileVersion: "1.0.0",
  official: true,
  reporterDigest: `sha256:${createHash("sha256").update(NODE_TEST_REPORTER_SOURCE).digest("hex")}`,
  capabilities: {
    detectsCollectionFailure: false,
    detectsCompileFailure: false,
    attributesPerAssertionFailure: true,
  },
};
