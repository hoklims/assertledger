# ADR 0002: Complete migration to Rust

Status: accepted

## Decision

Move all AssertLedger logic to Rust: core, contracts, engine, analysis, CLI, MCP server, and
`init`/`doctor`. The target is a complete migration, not a stable TypeScript/Rust hybrid. The
migration ships as a sequence of publishable releases, each verified from a fresh installation of
the published package.

The first Rust code shipped is an opt-in process-tree supervisor. It is the one place where Rust
gives a guarantee the Node implementation cannot: terminating a whole process tree, detached
grandchildren included.

## Rules

- A boundary between languages is always a process: arguments, standard streams, files, and exit
  codes. No in-process binding, no WASM, no synchronous call between TypeScript and Rust.
- In any release, each command has exactly one active implementation. A command moves from
  TypeScript to Rust in one release: the Rust implementation passes a differential test against
  the TypeScript one on goldens and the replay corpus, the CLI delegates the command to the binary
  with an unchanged public output, and the TypeScript implementation leaves the execution path. It
  stays in the repository as a test oracle until a complete Rust release shows no divergence.
- No published release offers a switch between the TypeScript and Rust implementations.
- A contract change and a language change never share a release.
- Any manifest or receipt produced by any version remains replayable, with the same decision and
  digests, by every later version. The language change rewrites no evidence.
- Only one contract source is editable at a time. Zod stays the source until locked JSON schemas
  replace it; Rust reads the published locked schemas, never TypeScript code.
- JavaScript assets that run in the user's runtime (Bun driver and preload, `node --test`
  reporter) remain JavaScript. Their digests stay bound in manifests.
- Every new toolchain or crate requires explicit approval before it is added.

## Consequences

- This supersedes the scope of [ADR 0001](0001-typescript-runtime.md): TypeScript was the runtime
  for the first vertical release, not the destination. Its requirement that a Rust backend prove
  byte-compatible canonical decisions with shared fixtures stays in force.
- Goldens for the CLI and MCP surfaces and a replay corpus of real v1–v5 manifests and
  qualification receipts are frozen before any Rust code ships. They are the differential oracles.
- Native binaries ship as platform packages declared in `optionalDependencies` of the `assertledger`
  package, then become required on the supported platform matrix. Outside that matrix, installation
  or launch refuses explicitly; it never falls back silently to another path.
- No performance figure or schedule is part of this decision: none has been measured.
