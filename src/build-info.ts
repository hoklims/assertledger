import { readFileSync } from "node:fs";
import {
  EvidenceProviderManifestSchema,
  type EvidenceProviderManifest,
} from "./contracts/index.js";

type SourceRevision = EvidenceProviderManifest["provider"]["sourceRevision"];

/**
 * Read the source revision recorded by `scripts/write-build-info.ts`. A missing file, unreadable
 * JSON, or an invalid record stays UNKNOWN rather than borrowing the current checkout's revision.
 */
export function readSourceRevision(location: URL): SourceRevision {
  try {
    const document = JSON.parse(readFileSync(location, "utf8")) as { sourceRevision?: unknown };
    const parsed = EvidenceProviderManifestSchema.shape.provider.shape.sourceRevision.safeParse(
      document.sourceRevision,
    );
    return parsed.success ? parsed.data : { status: "UNKNOWN" };
  } catch {
    return { status: "UNKNOWN" };
  }
}

export const ASSERTLEDGER_SOURCE_REVISION = readSourceRevision(
  new URL("./build-info.json", import.meta.url),
);
