import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { RepositoryInitResult } from "../contracts/index.js";
import {
  ClientConnectionApplyError,
  type ClientConnectionResult,
  connectClient,
  planClientConnection,
} from "./connection.js";
import { initializeRepository, RepositoryInitWriteError } from "./index.js";

export type SetupClient = "codex" | "claude-code";
export type RepositorySetupStatus =
  | "WOULD_CREATE"
  | "CREATED"
  | "UNCHANGED"
  | "BLOCKED"
  | "CONFLICT"
  | "PARTIAL_FAILURE";
export type RepositorySetupArtifactState =
  | "WOULD_CREATE"
  | "CREATED"
  | "UNCHANGED"
  | "CONFLICT"
  | "ROLLED_BACK"
  | "PARTIAL";

export interface RepositorySetupRollback {
  status: "NOT_REQUIRED" | "COMPLETE" | "PARTIAL";
  removed: string[];
  unresolved: string[];
}

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
  rollback: RepositorySetupRollback;
  limitations: string[];
}

export interface SetupRepositoryDependencies {
  afterInitApplied?(): Promise<void>;
  applyInit?(root: string): Promise<RepositoryInitResult>;
  applyConnection?(): Promise<ClientConnectionResult>;
}

const SETUP_LIMITATIONS = [
  "Setup configures static initialization and a read-only client connection only.",
  "It does not authorize UNSANDBOXED execution, reload the client, or prove repository behavior.",
  "Setup has no cross-process filesystem lock. Concurrent edits can be overwritten during lock regeneration or removed between a rollback byte check and unlink; run only while the trusted repository tree is stable.",
];

function initArtifactState(
  result: RepositoryInitResult,
  file: string,
): RepositorySetupArtifactState {
  if (result.status === "CONFLICT") return "CONFLICT";
  return result.actions.some((action) => action.path === file) ? "WOULD_CREATE" : "UNCHANGED";
}

async function rollbackCreatedInitFiles(
  root: string,
  plan: RepositoryInitResult,
  ownedPaths: readonly string[],
  changedUnownedPaths: readonly string[] = [],
): Promise<RepositorySetupRollback> {
  const removed: string[] = [];
  const unresolved = changedUnownedPaths.map((changedPath) =>
    path.relative(root, changedPath).split(path.sep).join("/"),
  );
  for (const ownedPath of ownedPaths) {
    const relative = path.relative(root, ownedPath).split(path.sep).join("/");
    const plannedFile = plan.files.find((file) => file.path === relative);
    if (plannedFile === undefined) {
      unresolved.push(relative);
      continue;
    }
    try {
      const metadata = await lstat(ownedPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        !(await readFile(ownedPath)).equals(Buffer.from(plannedFile.content, "utf8"))
      ) {
        unresolved.push(relative);
        continue;
      }
      await unlink(ownedPath);
      removed.push(relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") removed.push(relative);
      else unresolved.push(relative);
    }
  }
  removed.sort((left, right) => left.localeCompare(right));
  unresolved.sort((left, right) => left.localeCompare(right));
  return {
    status: unresolved.length === 0 ? "COMPLETE" : "PARTIAL",
    removed,
    unresolved,
  };
}

function rollbackArtifactState(
  root: string,
  artifact: RepositorySetupArtifact,
  rollback: RepositorySetupRollback,
): RepositorySetupArtifactState {
  const relative = path.relative(root, artifact.path).split(path.sep).join("/");
  if (rollback.removed.includes(relative)) return "ROLLED_BACK";
  if (rollback.unresolved.includes(relative)) return "PARTIAL";
  return artifact.state;
}

function mergeRollback(
  root: string,
  init: RepositorySetupRollback,
  connection: { removed: string[]; unresolved: string[] },
): RepositorySetupRollback {
  const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const removed = [...init.removed, ...connection.removed.map(relative)].sort((left, right) =>
    left.localeCompare(right),
  );
  const unresolved = [...init.unresolved, ...connection.unresolved.map(relative)].sort(
    (left, right) => left.localeCompare(right),
  );
  return { status: unresolved.length === 0 ? "COMPLETE" : "PARTIAL", removed, unresolved };
}

export async function setupRepository(
  root: string,
  cliEntry: string,
  client: SetupClient,
  write: boolean,
  dependencies: SetupRepositoryDependencies = {},
): Promise<RepositorySetupResult> {
  const initPlan = await initializeRepository(root, { dryRun: true });
  if (initPlan.status === "CONFLICT" && initPlan.reasonCodes.includes("REPOSITORY_ROOT_INVALID")) {
    return {
      status: "CONFLICT",
      client,
      mode: write ? "write" : "dry-run",
      init: initPlan,
      connection: { client, status: "CONFLICT", artifacts: [] },
      artifacts: [],
      rollback: { status: "NOT_REQUIRED", removed: [], unresolved: [] },
      limitations: [...SETUP_LIMITATIONS],
    };
  }
  root = await realpath(root);
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
    rollback: { status: "NOT_REQUIRED" as const, removed: [], unresolved: [] },
    limitations: [...SETUP_LIMITATIONS],
  };
  if (initPlan.status === "CONFLICT" || connectionPlan.result.status === "CONFLICT") {
    return { status: "CONFLICT", ...base };
  }
  if (initPlan.status === "BLOCKED") return { status: "BLOCKED", ...base };
  const unchanged = artifacts.every((artifact) => artifact.state === "UNCHANGED");
  if (!write) return { status: unchanged ? "UNCHANGED" : "WOULD_CREATE", ...base };

  let appliedInit: RepositoryInitResult;
  try {
    appliedInit = await (dependencies.applyInit?.(root) ?? initializeRepository(root));
  } catch (error) {
    const ownedPaths = error instanceof RepositoryInitWriteError ? error.installedPaths : [];
    const initRollback = await rollbackCreatedInitFiles(root, initPlan, ownedPaths);
    const temporaryArtifact =
      error instanceof RepositoryInitWriteError && error.temporaryCleanup !== "NOT_OWNED"
        ? {
            relative: path.relative(root, error.temporaryPath).split(path.sep).join("/"),
            absolute: error.temporaryPath,
            cleanup: error.temporaryCleanup,
          }
        : undefined;
    const rollback: RepositorySetupRollback = temporaryArtifact
      ? {
          status:
            initRollback.status === "PARTIAL" || temporaryArtifact.cleanup === "UNRESOLVED"
              ? "PARTIAL"
              : "COMPLETE",
          removed: [
            ...initRollback.removed,
            ...(temporaryArtifact.cleanup === "REMOVED" ? [temporaryArtifact.relative] : []),
          ].sort((left, right) => left.localeCompare(right)),
          unresolved: [
            ...initRollback.unresolved,
            ...(temporaryArtifact.cleanup === "UNRESOLVED" ? [temporaryArtifact.relative] : []),
          ].sort((left, right) => left.localeCompare(right)),
        }
      : initRollback;
    const failedArtifacts =
      temporaryArtifact === undefined
        ? artifacts
        : [
            ...artifacts,
            {
              owner: "init" as const,
              path: temporaryArtifact.absolute,
              state:
                temporaryArtifact.cleanup === "UNRESOLVED"
                  ? ("PARTIAL" as const)
                  : ("ROLLED_BACK" as const),
            },
          ];
    return {
      status: "PARTIAL_FAILURE",
      ...base,
      artifacts: failedArtifacts.map((artifact) => ({
        ...artifact,
        state:
          artifact.path === temporaryArtifact?.absolute
            ? artifact.state
            : rollbackArtifactState(root, artifact, rollback),
      })),
      rollback,
    };
  }
  if (appliedInit.status === "CONFLICT" || appliedInit.status === "BLOCKED") {
    return {
      status: appliedInit.status,
      ...base,
      init: appliedInit,
    };
  }
  let appliedConnection: ClientConnectionResult;
  try {
    await dependencies.afterInitApplied?.();
    appliedConnection = await (dependencies.applyConnection?.() ??
      connectClient(root, cliEntry, client, true));
  } catch (error) {
    const initRollback = await rollbackCreatedInitFiles(
      root,
      appliedInit,
      appliedInit.actions
        .filter((action) => action.kind === "CREATE")
        .map((action) => path.join(root, action.path)),
      appliedInit.actions
        .filter((action) => action.kind !== "CREATE")
        .map((action) => path.join(root, action.path)),
    );
    if (!(error instanceof ClientConnectionApplyError)) {
      return {
        status: "PARTIAL_FAILURE",
        ...base,
        init: appliedInit,
        artifacts: artifacts.map((artifact) => ({
          ...artifact,
          state: rollbackArtifactState(root, artifact, initRollback),
        })),
        rollback: initRollback,
      };
    }
    const rollback = mergeRollback(root, initRollback, error.rollback);
    return {
      status: "PARTIAL_FAILURE",
      ...base,
      init: appliedInit,
      artifacts: artifacts.map((artifact) => ({
        ...artifact,
        state: rollbackArtifactState(root, artifact, rollback),
      })),
      rollback,
    };
  }
  if (appliedConnection.status === "CONFLICT") {
    const rollback = await rollbackCreatedInitFiles(
      root,
      appliedInit,
      appliedInit.actions
        .filter((action) => action.kind === "CREATE")
        .map((action) => path.join(root, action.path)),
      appliedInit.actions
        .filter((action) => action.kind !== "CREATE")
        .map((action) => path.join(root, action.path)),
    );
    return {
      status: rollback.status === "COMPLETE" ? "CONFLICT" : "PARTIAL_FAILURE",
      ...base,
      init: appliedInit,
      connection: appliedConnection,
      artifacts: artifacts.map((artifact) => ({
        ...artifact,
        state:
          artifact.owner === "connection"
            ? ("CONFLICT" as const)
            : rollbackArtifactState(root, artifact, rollback),
      })),
      rollback,
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
