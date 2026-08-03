# TestForge

TestForge is a model-, provider-, harness-, and framework-independent evidence harness for candidate
automated tests. It runs each candidate against explicit code worlds, evaluates normalized evidence
with a versioned deterministic policy, selects eligible candidates, and emits an auditable manifest.

> An agent may propose tests. Only a versioned decision policy may decide what the observed runs
> demonstrate.

TestForge does **not** prove program correctness, complete fault detection, universal oracle quality,
or permanent freedom from flakiness. It answers a narrower question: did the submitted candidate
distinguish the operator-supplied worlds during the recorded attempts under the declared policy?

## What works in v0.1

- deterministic repository analysis for agent context;
- candidate test overlays restricted to configured test roots;
- reference, target, and neutral worlds supplied as file overlays;
- one immutable repository snapshot per campaign and a fresh workspace for every attempt;
- repeated execution with explicit budgets, bounded output capture, and stream digests;
- controls showing whether each world was green before adding a candidate;
- a built-in `node:test` adapter with runtime discovery and file-based failure attribution;
- a framework-neutral structured-command adapter protocol;
- deterministic gates, marginal-coverage selection, and decision and artifact digests;
- JSON CLI, TypeScript SDK, MCP stdio server, JSON Schema, and an agent skill.

The only execution backend in v0.1 is `trusted-local`. Every manifest records this backend as
`UNSANDBOXED`. **Do not use it for hostile or untrusted code.** Temporary directories, timeouts, and
an environment allowlist are resource controls, not a security boundary. See
[SECURITY.md](SECURITY.md).

## Architecture

```text
Agent or harness
      │
      ▼
Integration facade
Skill / MCP / JSON CLI / TypeScript SDK
      │
      ▼
TestForge orchestrator
Analysis / workspaces / execution / budgets / adapters
      │
      ▼
Deterministic core
Canonical evidence / gates / selection / manifest digests
```

Dependencies point downward. The core has no filesystem, process, network, clock, random, model, or
provider dependency. External execution can be nondeterministic; the decision function is
deterministic over normalized observations. See [docs/architecture.md](docs/architecture.md) and
[docs/proof-model.md](docs/proof-model.md).

## Install and verify

Requirements: Node.js 22.15 or newer and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

The following command executes repository and candidate code with the unsandboxed local backend.
Review the request first, then run it only on a disposable machine or an otherwise trusted checkout:

```sh
node dist/cli.js verify examples/node-test/request.json --allow-unsafe-execution --json
```

Expected process exit codes:

| Code | Meaning |
| ---: | --- |
| `0` | Command succeeded, or campaign `VERIFIED` |
| `2` | Campaign complete but `REJECTED` |
| `3` | Campaign `INCONCLUSIVE` |
| `4` | Invalid request or manifest |
| `5` | Engine or infrastructure error |
| `64` | CLI usage error |

## JSON CLI

```sh
testforge analyze . --json
testforge schema verification-request --json
testforge verify testforge.request.json --allow-unsafe-execution --json
testforge replay testforge.manifest.json --json
testforge mcp
# Operator-only opt-in: testforge mcp --allow-unsafe-execution
```

`verify` and `replay` also accept `-` or an omitted file argument and then read JSON from stdin. The
CLI rejects file and stdin JSON inputs larger than 16 MiB. JSON results go to stdout. Diagnostics go
to stderr. `testforge mcp` reserves stdout for JSON-RPC.

`--allow-unsafe-execution` is an external authorization signal. The CLI requires it for every
campaign and sets the request's local acknowledgement before validation. The flag does not create a
sandbox.

Versioned JSON Schemas are published for the
[`verification request`](schemas/verification-request.v1.json),
[`repository analysis`](schemas/repository-analysis.v1.json),
[`evidence manifest`](schemas/evidence-manifest.v1.json), and
[`replay result`](schemas/replay-result.v1.json). The CLI `schema` command prints any of these four
schemas by name. A complete runnable request is available at
[`examples/node-test/request.json`](examples/node-test/request.json).

## TypeScript SDK

```ts
import { readFile } from "node:fs/promises";
import { TestForge } from "testforge";

const testforge = new TestForge();
const context = await testforge.analyze("/absolute/path/to/repository");
const request = JSON.parse(await readFile("testforge.request.json", "utf8"));
const manifest = await testforge.verify(request);
const integrity = testforge.replay(manifest);
```

The SDK accepts plain JSON-compatible values and validates them against the same contracts as the
CLI. Unlike the CLI and MCP tool, `TestForge.verify()` has no separate authorization parameter: the
caller must set `isolation.acknowledgedUnsafeExecution` to `true` after applying its own policy.

`TestForge.replay()` reports schema validity, both digest checks, and deterministic decision-semantic
validity. Its aggregate `valid` field is true only when all four checks pass. Replay does not rerun
the campaign, authenticate the producer, or establish that the observations were truthful.

## MCP v2 over stdio

Start the read-only server with `testforge mcp`, or configure an MCP client with `testforge` as the
command and `["mcp"]` as its argument array. The default server exposes three tools:

| Tool | Purpose |
| --- | --- |
| `testforge_analyze` | Produce repository context for test generation |
| `testforge_schema` | Return any of the four published JSON Schemas |
| `testforge_replay` | Validate and replay a manifest's schema, digests, and decision semantics |

`testforge_verify` is absent by default. A server operator may register it by starting
`testforge mcp --allow-unsafe-execution`, or by calling `createTestForgeServer({
allowUnsafeExecution: true })`. The tool then accepts a verification request and executes it without
a second per-call authorization field. Run that server only inside the intended isolation boundary;
do not let an MCP caller decide whether the capability exists. The server resolves repository roots
to real paths and confines them to the server process's current working directory by default.
Programmatic operators may supply a different `allowedRepositoryRoots` allowlist.

## Continuous integration

Run `pnpm check` on every change. The included GitHub Actions workflow runs this gate on Node.js 22
and 24 on Ubuntu and Windows, then performs a package dry run. A CI job that executes campaigns must
also treat `trusted-local` as `UNSANDBOXED`: use an isolated runner without secrets or host
credentials, and pass `--allow-unsafe-execution` only from reviewed CI configuration.

## Decision semantics

- `VERIFIED`: at least one candidate completed all required evidence and was selected.
- `REJECTED`: the campaign completed, but no candidate satisfied the policy.
- `INCONCLUSIVE`: controls or candidate evidence were incomplete, unstable, timed out, or affected
  by infrastructure failure.
- `ENGINE_ERROR`: the deterministic core could not normalize the supplied evidence safely.

Only an attributed `ASSERTION_FAILURE` can kill a target in protocol v1. Compilation errors,
collection failures, crashes, timeouts, and infrastructure errors never count as target evidence.

Campaign budgets cover aggregate candidate, world, repository, overlay, and execution counts or
bytes. `timeoutMsPerExecution` and `maximumOutputBytes` apply to each process execution; the timeout
and process-tree termination are best effort on the local host.

Before a built-in `node:test` campaign runs, TestForge probes the requested executable, resolves its
real path, probes that resolved file again, and requires matching Node.js versions of at least
22.15. The manifest records the requested executable, resolved path, Node.js version, and executable
SHA-256 digest.

Each candidate records the ordered gates `COMPLETENESS`, `STABILITY`, `DISCOVERY`, `REFERENCE`,
`NEUTRAL`, and `TARGET_STRENGTH`, including evidence run IDs and reason codes. See
[docs/proof-model.md](docs/proof-model.md) for candidate statuses, controls, selection, and digest
scope.

The manifest is sufficient to replay TestForge's deterministic decision, but it is not a complete
audit archive. It stores content and process-output digests, not candidate or world bodies, a
repository archive, or raw logs. Preserve the original request, repository snapshot or trusted
source reference, raw logs, dependencies, and any structured-command executable identity separately
when independent audit or reproduction matters. Manifest digests detect changes; they do not
authenticate the producer.

## Project status and roadmap

Version `0.1.0` is a production-oriented foundation, not a claim of ecosystem completeness. The
deterministic core and protocols are framework-independent; `node:test` is the first built-in
framework adapter. Other frameworks integrate through the structured-command protocol described in
[docs/adapter-protocol.md](docs/adapter-protocol.md).

Planned work is not shipped behavior. Priorities include a real sandbox backend, additional
framework reporters with runtime attribution, signed provenance, cross-runtime conformance
fixtures, and more built-in adapters. See [docs/roadmap.md](docs/roadmap.md).

Contributions are welcome under the [MIT license](LICENSE). Read [CONTRIBUTING.md](CONTRIBUTING.md)
before changing a public contract.
