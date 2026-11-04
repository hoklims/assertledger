# ADR 0003: Retire the public JavaScript API in 3.0.0

Status: accepted

## Decision

AssertLedger's public contract becomes the CLI, the MCP server, and the published JSON schemas.
The `assertledger` package stops exposing a JavaScript API. This is a breaking change shipped alone
in 3.0.0, still implemented in TypeScript, before any command moves to Rust.

3.0.0 removes the `.`, `./core`, and `./bun` exports, the `main` and `types` entries, and every
JavaScript symbol they expose, including `TestForge` and `createAssertLedgerServer`. The package
keeps its `bin` entries only.

## Rationale

`./core` exposes pure synchronous functions. Keeping it while the core moves to Rust would require
an in-process boundary, which [ADR 0002](0002-complete-rust-migration.md) excludes. Removing the API
first means no WASM boundary is built and then discarded, and no synchronous SDK must be preserved
across the language change.

## Preparation in 2.x

- A mapping from every public SDK method to a CLI command or MCP tool is published. A method without
  an equivalent blocks the last 2.x release.
- The last 2.x release adds `assertledger core <op>`, whose scope is decided separately, and emits
  deprecation warnings for `.`, `./core`, and `assertSame`, with a migration guide.
- At least one 2.x release carries these warnings before 3.0.0.

## Consequences

- The `testforge` bin alias and the `testforge_*` MCP tools are not part of the JavaScript API and
  are not removed by this decision.
- Existing v1–v5 manifests remain replayable through the CLI and MCP surfaces.
- Maintenance of the 2.x branch after 3.0.0 is decided separately.
- Public consumers of the JavaScript API outside the maintainers' machines are unknown; the
  deprecation release is the only notice they receive.
