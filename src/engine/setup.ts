import path from "node:path";
import type { RepositoryInitResult } from "../contracts/index.js";
import { type ClientConnectionResult, connectClient, planClientConnection } from "./connection.js";
import { initializeRepository } from "./index.js";

export type SetupClient = "codex" | "claude-code";
export type RepositorySetupStatus =
  | "WOULD_CREATE"
  | "CREATED"
  | "UNCHANGED"
  | "BLOCKED"
  | "CONFLICT";
export type RepositorySetupArtifactState = "WOULD_CREATE" | "CREATED" | "UNCHANGED" | "CONFLICT";

export interface RepositorySetupArtifact {
  owner: "init" | "connection";
  path: string;
  state: RepositorySetupArtifactState;
}

export interface RepositorySetupResult {
  status: RepositorySetupStatus;
  client: SetupClient;
  mode: "dry-run" | "write";
  init: RepositoryInitResult;
  connection: ClientConnectionResult;
  artifacts: RepositorySetupArtifact[];
  limitations: string[];
}

function initArtifactState(
  result: RepositoryInitResult,
  file: string,
): RepositorySetupArtifactState {
  if (result.status === "CONFLICT") return "CONFLICT";
  return result.actions.some((action) => action.path === file) ? "WOULD_CREATE" : "UNCHANGED";
}

export async function setupRepository(
  root: string,
  cliEntry: string,
  client: SetupClient,
  write: boolean,
): Promise<RepositorySetupResult> {
  const initPlan = await initializeRepository(root, { dryRun: true });
  const connectionPlan = await planClientConnection(root, cliEntry, client);
  const initArtifacts: RepositorySetupArtifact[] = initPlan.files.map((file) => ({
    owner: "init",
    path: path.join(root, file.path),
    state: initArtifactState(initPlan, file.path),
  }));
  const connectionArtifacts: RepositorySetupArtifact[] = connectionPlan.result.artifacts.flatMap(
    (artifact, index) => {
      if (artifact.path === null) return [];
      const state = connectionPlan.states[index];
      if (state === undefined) throw new Error("CONNECT_PLAN_INCONSISTENT");
      return [
        {
          owner: "connection" as const,
          path: artifact.path,
          state: state === "ABSENT" ? ("WOULD_CREATE" as const) : state,
        },
      ];
    },
  );
  const artifacts = [...initArtifacts, ...connectionArtifacts];
  const base = {
    client,
    mode: write ? ("write" as const) : ("dry-run" as const),
    init: initPlan,
    connection: connectionPlan.result,
    artifacts,
    limitations: [
      "Setup configures static initialization and a read-only client connection only.",
      "It does not authorize UNSANDBOXED execution, reload the client, or prove repository behavior.",
    ],
  };
  if (initPlan.status === "CONFLICT" || connectionPlan.result.status === "CONFLICT") {
    return { status: "CONFLICT", ...base };
  }
  if (initPlan.status === "BLOCKED") return { status: "BLOCKED", ...base };
  const unchanged = artifacts.every((artifact) => artifact.state === "UNCHANGED");
  if (!write) return { status: unchanged ? "UNCHANGED" : "WOULD_CREATE", ...base };

  const appliedInit = await initializeRepository(root);
  if (appliedInit.status === "CONFLICT" || appliedInit.status === "BLOCKED") {
    return {
      status: appliedInit.status,
      ...base,
      init: appliedInit,
    };
  }
  const appliedConnection = await connectClient(root, cliEntry, client, true);
  if (appliedConnection.status === "CONFLICT") {
    return {
      status: "CONFLICT",
      ...base,
      init: appliedInit,
      connection: appliedConnection,
    };
  }
  const appliedArtifacts = artifacts.map((artifact) => ({
    ...artifact,
    state: artifact.state === "WOULD_CREATE" ? ("CREATED" as const) : ("UNCHANGED" as const),
  }));
  return {
    status:
      appliedInit.status === "UNCHANGED" && appliedConnection.status === "UNCHANGED"
        ? "UNCHANGED"
        : "CREATED",
    ...base,
    init: appliedInit,
    connection: appliedConnection,
    artifacts: appliedArtifacts,
  };
}
