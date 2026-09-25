import { cp, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEvidenceManifest, parseVerificationRequest } from "../contracts/index.js";
import { verifyCampaign } from "./index.js";

export interface FixtureDemoResult {
  status: "VERIFIED" | "REJECTED";
  scope: "SHIPPED_FIXTURE_ONLY";
  artifactDigest: string;
  selectedCandidateIds: string[];
  limitation: string;
  temporaryWorkspaceRemoved: true;
}

async function packageRoot(requestedCliEntry: string): Promise<string> {
  const cliEntry = await realpath(requestedCliEntry);
  if (
    !(await stat(cliEntry)).isFile() ||
    path.basename(cliEntry) !== "cli.js" ||
    path.basename(path.dirname(cliEntry)) !== "dist"
  ) {
    throw new Error("DEMO_BUILD_REQUIRED");
  }
  return path.dirname(path.dirname(cliEntry));
}

export async function runFixtureDemo(
  requestedCliEntry: string,
  allowUnsafeExecution: boolean,
): Promise<FixtureDemoResult> {
  if (!allowUnsafeExecution) throw new Error("UNSAFE_LOCAL_EXECUTION_NOT_ACKNOWLEDGED");
  const root = await packageRoot(requestedCliEntry);
  const exampleRoot = path.join(root, "examples", "node-test");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "assertledger-demo-"));
  let result: Omit<FixtureDemoResult, "temporaryWorkspaceRemoved"> | undefined;
  try {
    const repository = path.join(temporaryRoot, "repository");
    await cp(path.join(exampleRoot, "repository"), repository, {
      recursive: true,
      errorOnExist: true,
    });
    const request = JSON.parse(await readFile(path.join(exampleRoot, "request.json"), "utf8")) as {
      repository: { root: string };
    };
    request.repository.root = repository;
    const requestPath = path.join(temporaryRoot, "request.json");
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, { flag: "wx" });
    const manifest = parseEvidenceManifest(await verifyCampaign(parseVerificationRequest(request)));
    result = {
      status: manifest.decision.status === "VERIFIED" ? "VERIFIED" : "REJECTED",
      scope: "SHIPPED_FIXTURE_ONLY",
      artifactDigest: manifest.artifactDigest,
      selectedCandidateIds: [...manifest.decision.selectedCandidateIds],
      limitation:
        "This demonstration verifies only AssertLedger's shipped disposable fixture; it does not prove any user repository.",
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  if (result === undefined) throw new Error("DEMO_RESULT_UNAVAILABLE");
  return { ...result, temporaryWorkspaceRemoved: true };
}
