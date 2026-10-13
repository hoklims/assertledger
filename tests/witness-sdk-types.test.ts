import assert from "node:assert/strict";
import { it } from "node:test";
import type {
  EvidenceManifestV4Contract,
  EvidenceManifestV5Contract,
  WitnessImportRequest,
  WitnessImportRequestV2,
} from "../src/contracts/index.js";
import type { WitnessImportOptions } from "../src/engine/witness-import.js";
import { AssertLedger } from "../src/sdk/index.js";

it("preserves versioned witness SDK return types", () => {
  const ledger = new AssertLedger();
  const v1: (
    request: WitnessImportRequest,
    options: WitnessImportOptions,
  ) => Promise<EvidenceManifestV4Contract> = (request, options) =>
    ledger.importWitness(request, options);
  const v2: (
    request: WitnessImportRequestV2,
    options: WitnessImportOptions,
  ) => Promise<EvidenceManifestV5Contract> = (request, options) =>
    ledger.importWitness(request, options);
  const unknown: (
    request: unknown,
    options: WitnessImportOptions,
  ) => Promise<EvidenceManifestV4Contract | EvidenceManifestV5Contract> = (request, options) =>
    ledger.importWitness(request, options);
  assert.deepEqual(
    [v1, v2, unknown].map((entry) => typeof entry),
    ["function", "function", "function"],
  );
});
